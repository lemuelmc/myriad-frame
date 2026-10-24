/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

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
import { loadHubConfig } from './config'
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

/** List files in a HF repo (recursive tree API, includes sizes). */
async function listRepoFiles(repo: string): Promise<HfFile[]> {
  const url = `${HF_API}/models/${repo}/tree/main?recursive=true`
  const data = (await httpGetJson(url)) as Array<{ type?: string; path: string; size?: number }>
  return data
    .filter((f) => f.type === 'file')
    .map((f) => ({ path: f.path, size: f.size }))
}

function quantFromName(name: string): string | undefined {
  const m = name.match(/(Q\d+[_A-Z0-9]*|FP8|FP16|BF16|F16|Q8_0|Q4_0|Q5_0|Q5_1|Q6_K|Q8_K|Q4_K_M|Q4_K_S|Q5_K_M|Q5_K_S|Q6_K|Q8_K|F16|BF16|FP16)/i)
  return m ? m[1] : undefined
}

/**
 * Scan the hub repos from hub.json and build the catalog:
 * - diffusion: repo tree (gguf/safetensors files)
 * - encoder: repo tree (gguf files) + the configured default file
 * - vae: direct file URL from hub.json
 */
export async function buildCatalog(onProgress?: (msg: string) => void): Promise<HubCatalog> {
  const hub = loadHubConfig()
  const entries: CatalogEntry[] = []

  // diffusion models
  for (const d of hub.repo.diffusion) {
    onProgress?.(`Scanning ${d.url}`)
    const repo = d.url.replace(/^https?:\/\/huggingface\.co\//, '')
    const files = await listRepoFiles(repo)
    for (const f of files) {
      const ext = f.path.toLowerCase()
      if (ext.endsWith('.gguf') || ext.endsWith('.safetensors')) {
        entries.push({
          id: `diffusion:${d.diffusion_type}:${f.path}`,
          type: 'diffusion' as ModelType,
          diffusionType: d.diffusion_type,
          name: f.path,
          label: f.path,
          url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
          size: f.size,
          quant: quantFromName(f.path),
          repo: repo,
          provider: d.provider
        })
      }
    }
  }

  // encoders
  for (const [diffusionType, enc] of Object.entries(hub.repo.encoder)) {
    onProgress?.(`Scanning ${enc.url}`)
    const repo = enc.url.replace(/^https?:\/\/huggingface\.co\//, '')
    // `default` may be a full URL or a repo-relative path — normalize to repo-relative
    const defaultPath = enc.default
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
        id: `encoder:${diffusionType}:${f.path}`,
        type: 'encoder' as ModelType,
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
        ...(enc.provider ? { provider: enc.provider } : {})
      })
    }
    // ensure the configured default is present
    if (!seen.has(defaultPath)) {
      const size = await headSize(defaultUrl)
      entries.push({
        id: `encoder:${diffusionType}:${defaultName}`,
        type: 'encoder' as ModelType,
        diffusionType,
        name: defaultName,
        label: defaultName,
        url: defaultUrl,
        size,
        quant: quantFromName(defaultName),
        // provider selects the per-provider download subdirectory
        ...(enc.provider ? { provider: enc.provider } : {}),
        isDefault: true
      })
    }
  }

  // vision (mmproj / projection model) — repo tree (.gguf) + the configured default file
  for (const [diffusionType, vis] of Object.entries(hub.repo.vision)) {
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
    source: hub.name,
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
