/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import type { CatalogEntry, HubCatalog, ModelType } from '@shared/types'
import { loadApplicationConfig, loadHubConfig } from './config'
import { headSize } from './download'

const HF_API = 'https://huggingface.co/api'

import { dataRoot } from './data'

function catalogPath(): string {
  return join(dataRoot(), 'cache', 'hub-catalog.json')
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        httpGetJson(new URL(res.headers.location, url).toString()).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString('utf-8')))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => {
      req.destroy()
      reject(new Error(`Timeout for ${url}`))
    })
  })
}

interface HfFile {
  path: string
  size?: number
}

/**
 * List files in a HF repo.
 * - `folder` undefined: recursive listing of the whole repo
 * - `folder` a name ("TURBO", "a/b"): only that folder's direct children
 *   (no recursion)
 * - `folder` '' (empty string): only the repo root's direct children
 *   (no recursion) — the `path: "/"` hub.json form
 * The direct-children filter is applied here so the shape diagnostic below
 * can compare the raw response against the filtered result; paths are
 * repo-root-relative either way.
 */
async function listRepoFiles(repo: string, folder?: string): Promise<HfFile[]> {
  const rootOnly = folder === ''
  // per-segment encoding: a nested folder ("a/b") must keep its slash —
  // a whole-string encodeURIComponent would emit "a%2Fb", which the HF
  // router does not resolve to the nested path
  const suffix = folder
    ? `/${folder.split('/').map(encodeURIComponent).join('/')}`
    : ''
  // recursion only for the whole-repo scan (folder undefined); folder and
  // root-only ('') scans list direct children, so no recursive param
  const url =
    `${HF_API}/models/${repo}/tree/main${suffix}` +
    (folder === undefined ? '?recursive=true' : '')
  const data = (await httpGetJson(url)) as Array<{ type?: string; path: string; size?: number }>
  let files = data
    .filter((f) => f.type === 'file')
    .map((f) => ({ path: f.path, size: f.size }))
  if (folder !== undefined) {
    // direct children only. Defensive guard — the non-recursive call should
    // already return only immediate children (directories come back as
    // `type: "directory"` and are dropped above), so API quirks can't leak
    // nested files. Repo-root-relative paths either way:
    // - root scan (''): no slash at all
    // - folder scan: the folder prefix and no further slash after it
    files = rootOnly
      ? files.filter((f) => !f.path.includes('/'))
      : files.filter(
          (f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/')
        )
    // shape-mismatch diagnostic: the direct-children filter assumes the
    // non-recursive tree returns repo-root-relative paths. When the raw
    // response had model files but none survived the filter, that
    // assumption is wrong (e.g. folder-relative paths) — say so instead
    // of silently emitting URLs that would 404.
    const isModel = (p: string): boolean => /\.(gguf|safetensors)$/i.test(p)
    const rawHadModels = data.some((f) => f.type === 'file' && isModel(f.path))
    if (rawHadModels && !files.some((f) => isModel(f.path))) {
      console.warn(
        `[hub] ${rootOnly ? 'repo root' : `folder "/${folder}"`} in ${repo}: raw tree response had model files but none survived the direct-children filter — verify the tree API response shape (repo-root-relative paths, no unexpected recursion)`
      )
    }
  }
  return files
}

function quantFromName(name: string): string | undefined {
  const m = name.match(/(Q\d+[_A-Z0-9]*|FP8|FP16|BF16|F16|Q8_0|Q4_0|Q5_0|Q5_1|Q6_K|Q8_K|Q4_K_M|Q4_K_S|Q5_K_M|Q5_K_S|Q6_K|Q8_K|F16|BF16|FP16)/i)
  return m ? m[1] : undefined
}

/**
 * Scan the hub repos from hub.json and build the catalog:
 * - diffusion: repo tree (gguf/safetensors files)
 * - encoder: repo tree (gguf files) + the configured default file (single-file
 *   `default`) or the configured `defaults[]` bundle files (SD3.5-style
 *   multi-encoder; bundle entries carry the `use_as` flag name as `useAs`)
 * - vae: direct file URL from hub.json
 */
export async function buildCatalog(onProgress?: (msg: string) => void): Promise<HubCatalog> {
  const hub = loadHubConfig()
  const entries: CatalogEntry[] = []

  // diffusion models
  for (const d of hub.repo.diffusion) {
    // normalize the optional path restriction:
    // - "/TURBO" -> "TURBO", "./x/" -> "x" — scan that folder's direct children
    // - "/", "./" (or a bare ".") -> root-only scan — direct children of the
    //   repo root, no recursion (subfolder files are NOT listed)
    // - absent/empty -> whole-repo recursive scan (legacy behavior)
    const raw = typeof d.path === 'string' ? d.path.trim() : ''
    const normalized = raw.replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
    // NOTE: `folder` may be nested ("a/b"); the tree call encodes it
    // per-segment and the direct-children filter inside listRepoFiles
    // handles nesting correctly (no further slash after "a/b/"). Root-only
    // is expressed as folder '' (see listRepoFiles).
    const rootOnly = raw !== '' && (normalized === '' || normalized === '.')
    const folder = rootOnly ? '' : normalized || undefined
    const where = rootOnly ? ' (root folder only)' : folder ? ` (folder: /${folder})` : ''
    onProgress?.(`Scanning ${d.url}${where}`)
    const repo = d.url.replace(/^https?:\/\/huggingface\.co\//, '')
    // A missing folder (typo, renamed/removed upstream) can answer HTTP 404;
    // an unhandled rejection here would fail the whole catalog scan. Catch,
    // warn, and contribute no rows — consistent with the zero-result policy.
    let scanned: HfFile[]
    try {
      scanned = await listRepoFiles(repo, folder)
    } catch (e) {
      if (folder === undefined) throw e // whole-repo scans keep their fail-loud behavior
      console.warn(
        `[hub] diffusion entry "${d.name}" ${rootOnly ? 'root' : `path "/${folder}"`} scan failed (${(e as Error).message}); contributing no rows`
      )
      onProgress?.(`Scan failed for ${rootOnly ? 'repo root' : `/${folder}`} in ${d.url} — skipping`)
      continue
    }
    // listRepoFiles already applied the direct-children filter when a
    // folder (or the root-only '') was passed — nothing further to filter here
    const files = scanned
    if (folder !== undefined && files.length === 0) {
      // listRepoFiles additionally logs a shape-mismatch diagnostic when the
      // raw response had model files but the direct-children filter dropped
      // them all (repo-root-relative vs folder-relative path shapes).
      console.warn(
        `[hub] diffusion entry "${d.name}" ${rootOnly ? 'repo root' : `path "/${folder}"`} matched no files`
      )
      onProgress?.(`No files ${rootOnly ? 'at repo root' : `under /${folder}`} in ${d.url}`)
    }
    for (const f of files) {
      const ext = f.path.toLowerCase()
      if (ext.endsWith('.gguf') || ext.endsWith('.safetensors')) {
        // path-restricted entries surface the basename: downloads store
        // basename(url), gen:start resolves by name, and installed-tag
        // matching compares on-disk basenames — a slash-name breaks all three.
        // Root-only files carry no slash, so the basename equals f.path there.
        const name = folder !== undefined ? (f.path.split('/').pop() ?? f.path) : f.path
        entries.push({
          id: `diffusion:${d.diffusion_type}:${f.path}`,
          type: 'diffusion' as ModelType,
          diffusionType: d.diffusion_type,
          name,
          label: name,
          url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
          size: f.size,
          quant: quantFromName(f.path),
          repo: repo,
          provider: d.provider,
          // Optional per-repo description from hub.json — conditional spread,
          // the same pattern the encoder / vision / vae loops use for their
          // optional fields.
          ...(d.description ? { description: d.description } : {})
        })
      }
    }
  }

  // encoders
  for (const [diffusionType, enc] of Object.entries(hub.repo.encoder)) {
    // A usable repo URL is required (tree scan + resolve URLs). A malformed
    // entry is skipped with a warning instead of crashing the whole scan —
    // the same lenient-to-consumers philosophy as the config validator. Note
    // the bundled config is loaded without validation, so this guard is the
    // safety net for a bad bundled shape too.
    if (typeof enc.url !== 'string' || enc.url === '') {
      console.warn(`[hub] encoder entry "${diffusionType}" has no url; skipping`)
      continue
    }
    onProgress?.(`Scanning ${enc.url}`)
    const repo = enc.url.replace(/^https?:\/\/huggingface\.co\//, '')
    // Bundle shape (`defaults[]`, SD3.5-style multi-encoder) vs single-file
    // shape (`default`). The normalization below dereferences `enc.default` /
    // `item.file`, so it must stay inside the branch that guarantees the
    // field exists — a bundle-only entry has no `default`, and an unguarded
    // `enc.default.replace(...)` here would crash the whole scan.
    const bundle =
      Array.isArray(enc.defaults) && enc.defaults.length > 0 ? enc.defaults : undefined
    // path -> use_as for the bundle files; `file` is normalized the same way
    // `default` is (a full-URL form is stripped to a repo-relative path).
    const bundleMap = new Map<string, string>()
    for (const item of bundle ?? []) {
      if (typeof item.file !== 'string' || item.file === '') continue
      const p = item.file
        .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
        .replace(/^\//, '')
      bundleMap.set(p, item.use_as)
    }
    // `default` may be a full URL or a repo-relative path — normalize to
    // repo-relative. Guarded: bundle-only entries carry no `default`.
    const defaultPath =
      typeof enc.default === 'string' && enc.default !== ''
        ? enc.default
            .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
            .replace(/^\//, '')
        : undefined
    const files = await listRepoFiles(repo)
    const seen = new Set<string>()
    for (const f of files) {
      if (!f.path.toLowerCase().endsWith('.gguf')) continue
      seen.add(f.path)
      const bundleUseAs = bundleMap.get(f.path)
      entries.push({
        id: `encoder:${diffusionType}:${f.path}`,
        type: 'encoder' as ModelType,
        diffusionType,
        name: f.path,
        label: f.path,
        url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
        size: f.size,
        quant: quantFromName(f.path),
        repo,
        // the configured default file(s) may already be in the repo tree —
        // flag them so consumers can resolve them without a separate entry.
        // Bundle files additionally carry the `use_as` CLI flag name.
        ...(f.path === defaultPath ? { isDefault: true } : {}),
        ...(bundleUseAs !== undefined ? { isDefault: true, useAs: bundleUseAs } : {}),
        ...(enc.provider ? { provider: enc.provider } : {})
      })
    }
    // ensure the configured default is present
    if (defaultPath !== undefined && !seen.has(defaultPath)) {
      const name = defaultPath.split('/').pop() ?? defaultPath
      const url = `https://huggingface.co/${repo}/resolve/main/${defaultPath}`
      const size = await headSize(url)
      entries.push({
        id: `encoder:${diffusionType}:${name}`,
        type: 'encoder' as ModelType,
        diffusionType,
        name,
        label: name,
        url,
        size,
        quant: quantFromName(name),
        // provider selects the per-provider download subdirectory
        ...(enc.provider ? { provider: enc.provider } : {}),
        isDefault: true
      })
    }
    // ensure every bundle file is present (the tree scan keeps only .gguf, so
    // .safetensors bundle files always come from this synthesis branch)
    for (const [p, useAs] of bundleMap) {
      if (seen.has(p)) continue
      const name = p.split('/').pop() ?? p
      const url = `https://huggingface.co/${repo}/resolve/main/${p}`
      const size = await headSize(url)
      entries.push({
        id: `encoder:${diffusionType}:${name}`,
        type: 'encoder' as ModelType,
        diffusionType,
        name,
        label: name,
        url,
        size,
        quant: quantFromName(name),
        // provider selects the per-provider download subdirectory
        ...(enc.provider ? { provider: enc.provider } : {}),
        isDefault: true,
        useAs
      })
    }
  }

  // vision (mmproj / projection model) — repo tree (.gguf) + the configured default file
  // `vision` is optional in HubConfig (absent when no diffusion type needs one).
  for (const [diffusionType, vis] of Object.entries(hub.repo.vision ?? {})) {
    onProgress?.(`Scanning ${vis.url}`)
    const repo = vis.url.replace(/^https?:\/\/huggingface\.co\//, '')
    // `default` may be a full URL or a repo-relative path — normalize to repo-relative
    const defaultPath = vis.default
      .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
      .replace(/^\//, '')
    const defaultName = defaultPath.split('/').pop() ?? defaultPath
    const defaultUrl = `https://huggingface.co/${repo}/resolve/main/${defaultPath}`
    const files = await listRepoFiles(repo)
    const seen = new Set<string>()
    for (const f of files) {
      if (!f.path.toLowerCase().endsWith('.gguf')) continue
      seen.add(f.path)
      entries.push({
        id: `vision:${diffusionType}:${f.path}`,
        type: 'vision' as ModelType,
        diffusionType,
        name: f.path,
        label: f.path,
        url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
        size: f.size,
        quant: quantFromName(f.path),
        repo,
        // the configured default file may already be in the repo tree —
        // flag it so consumers can resolve it without a separate entry
        ...(f.path === defaultPath ? { isDefault: true } : {}),
        ...(vis.provider ? { provider: vis.provider } : {})
      })
    }
    // ensure the configured default is present
    if (!seen.has(defaultPath)) {
      const size = await headSize(defaultUrl)
      entries.push({
        id: `vision:${diffusionType}:${defaultName}`,
        type: 'vision' as ModelType,
        diffusionType,
        name: defaultName,
        label: vis.label ?? defaultName,
        url: defaultUrl,
        size,
        quant: quantFromName(defaultName),
        // provider selects the per-provider download subdirectory
        ...(vis.provider ? { provider: vis.provider } : {}),
        isDefault: true
      })
    }
  }

  // vae (repo + default file; the legacy plain-URL form is still accepted)
  for (const [diffusionType, v] of Object.entries(hub.repo.vae)) {
    if (typeof v === 'string') {
      onProgress?.(`Checking VAE ${v}`)
      const name = v.split('/').pop() ?? 'vae.safetensors'
      const size = await headSize(v)
      entries.push({
        id: `vae:${diffusionType}:${name}`,
        type: 'vae' as ModelType,
        diffusionType,
        name,
        label: name,
        url: v,
        size,
        quant: quantFromName(name),
        isDefault: true
      })
      continue
    }
    onProgress?.(`Checking VAE ${v.url}`)
    const repo = v.url.replace(/^https?:\/\/[^/]+\//, '')
    // `default` may be a full URL or a repo-relative path — normalize to repo-relative
    const defaultPath = v.default
      .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
      .replace(/^\//, '')
    const name = defaultPath.split('/').pop() ?? defaultPath
    const vaeUrl = `https://huggingface.co/${repo}/resolve/main/${defaultPath}`
    const size = await headSize(vaeUrl)
    entries.push({
      id: `vae:${diffusionType}:${name}`,
      type: 'vae' as ModelType,
      diffusionType,
      name,
      label: name,
      url: vaeUrl,
      size,
      quant: quantFromName(name),
      // provider selects the per-provider download subdirectory
      ...(v.provider ? { provider: v.provider } : {}),
      isDefault: true
    })
  }

  const catalog: HubCatalog = {
    scannedAt: Date.now(),
    // App identity now lives in application.json (hub.json no longer carries `name`).
    source: loadApplicationConfig().name,
    entries
  }
  return catalog
}

export interface HubService {
  get: () => HubCatalog | null
  refresh: (onProgress?: (msg: string) => void) => Promise<HubCatalog>
}

export function createHubService(): HubService {
  function get(): HubCatalog | null {
    const p = catalogPath()
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as HubCatalog
    } catch {
      return null
    }
  }

  async function refresh(onProgress?: (msg: string) => void): Promise<HubCatalog> {
    const catalog = await buildCatalog(onProgress)
    const p = catalogPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(catalog, null, 2))
    return catalog
  }

  return { get, refresh }
}
