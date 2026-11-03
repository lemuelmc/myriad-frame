/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogEntry, HubCatalog, ModelType } from '@shared/types'
import { loadApplicationConfig, loadHubConfig } from './config'
import { headSize } from './download'
// Importing './sources' runs sources/index.ts's module-scope registerSources()
// BEFORE the first buildCatalog() call (P2.3) — hub.ts and the sources/ dir
// are siblings under src/main/services/. Without it the registry stays empty
// and every entry would be "unknown" (warn + skip → an empty catalog).
import { getSourceForEntry } from './sources'
import type { RepoFile } from './sources/model-source'
import { dataRoot } from './data'

function catalogPath(): string {
  return join(dataRoot(), 'cache', 'hub-catalog.json')
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
 * - lora: repo tree (gguf/safetensors files), one entry per `diffustion_types`
 *   member (a LoRA may serve several diffusion types); no `default` concept
 * - vae: direct file URL from hub.json
 * - vision: repo tree (.gguf files) + the configured default file
 * - tokenizer: ONLY the configured default file (no repo tree scan — tokenizer
 *   repos are full weights repos; a tokenizer is a single small file)
 *
 * The six loops own the catalog SHAPE (entry fields, name/label policy,
 * default synthesis); the model SOURCE owns the TRANSPORT (repo listing API,
 * URL grammar — see `sources/`). Dispatch happens before each loop's scan
 * try/catch: an unknown source is a dispatch miss → warn + skip (uniformly
 * lenient), while a KNOWN source's scan failure keeps the per-loop semantics
 * (diffusion folder-scans warn + contribute no rows; whole-repo diffusion
 * re-throws; encoder/vae/vision scans and the vae/tokenizer default resolution
 * fail the whole build; lora scans are ALWAYS lenient — warn + contribute no
 * rows, never failing the build).
 */
export async function buildCatalog(onProgress?: (msg: string) => void): Promise<HubCatalog> {
  const hub = loadHubConfig()
  const entries: CatalogEntry[] = []
  // P2.3 tripwire counters: entries pushed through a source dispatch, and
  // loop iterations eligible for a dispatch (every repo entry except the
  // legacy plain-URL VAE strings, which bypass the source by design). A
  // build that dispatches ZERO entries while eligible entries exist means
  // the source registry was never populated (an import-wiring regression) —
  // the lenient unknown-source policy would otherwise turn that into a
  // silent empty catalog. Logged LOUDLY, once per build.
  let dispatchedEntries = 0
  let eligibleEntries = 0

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
    // per-segment and the direct-children filter inside the source's
    // listFiles handles nesting correctly (no further slash after "a/b/").
    // Root-only is expressed as folder '' (see HuggingFaceSource.listFiles).
    const rootOnly = raw !== '' && (normalized === '' || normalized === '.')
    const folder = rootOnly ? '' : normalized || undefined
    // Optional CivitAI version filter (hub.json `model_version_ids`): when
    // present and non-empty, only those model versions are listed. Threaded
    // as a scan option — sources that don't support it (HF) ignore it.
    // Defensively shape-checked here because the bundled config is loaded
    // without validation: a malformed value degrades to "no filter" instead
    // of crashing or emptying the scan.
    const versionIds = Array.isArray(d.model_version_ids)
      ? d.model_version_ids.filter((n) => typeof n === 'number' && Number.isFinite(n))
      : []
    // Optional pagination cap (hub.json `max_page`, HF entries) — the same
    // defensive shape-check as versionIds: a malformed value degrades to the
    // default 1-page scan instead of crashing.
    const maxPage =
      typeof d.max_page === 'number' && Number.isFinite(d.max_page) && d.max_page >= 1
        ? Math.floor(d.max_page)
        : undefined
    const versionWhere =
      versionIds.length > 0
        ? ` [${versionIds.length} version${versionIds.length === 1 ? '' : 's'}]`
        : ''
    const where =
      (rootOnly ? ' (root folder only)' : folder ? ` (folder: /${folder})` : '') + versionWhere
    onProgress?.(`Scanning ${d.url}${where}`)
    eligibleEntries++
    // Dispatch happens BEFORE the scan try/catch: an unknown source never
    // reaches listFiles, so the per-loop catch semantics are moot for this
    // failure class.
    const source = getSourceForEntry(d.url, d.source ?? d.domain)
    if (!source) {
      console.warn(`[hub] diffusion entry "${d.name}" (${d.url}): no model source for this URL's host — skipping`)
      continue
    }
    // One derivation, owned by the source (P2.5): repoFromUrl is the inverse
    // of resolveUrl, byte-identical to the old huggingface.co host-strip for
    // the bundled two-segment HF repo URLs — so CatalogEntry.repo (and the
    // future auth token key) can never diverge from the download-time slug.
    const repo = source.repoFromUrl(d.url)
    // A missing folder (typo, renamed/removed upstream) can answer HTTP 404;
    // an unhandled rejection here would fail the whole catalog scan. Catch,
    // warn, and contribute no rows — consistent with the zero-result policy.
    let scanned: RepoFile[]
    try {
      scanned = await source.listFiles(
        repo,
        folder,
        versionIds.length > 0 || maxPage !== undefined ? { versionIds, maxPage } : undefined
      )
    } catch (e) {
      if (folder === undefined) throw e // whole-repo scans keep their fail-loud behavior
      console.warn(
        `[hub] diffusion entry "${d.name}" ${rootOnly ? 'root' : `path "/${folder}"`} scan failed (${(e as Error).message}); contributing no rows`
      )
      onProgress?.(`Scan failed for ${rootOnly ? 'repo root' : `/${folder}`} in ${d.url} — skipping`)
      continue
    }
    // listFiles already applied the direct-children filter when a
    // folder (or the root-only '') was passed — nothing further to filter here
    const files = scanned
    if ((folder !== undefined || versionIds.length > 0) && files.length === 0) {
      // listFiles additionally logs a shape-mismatch diagnostic when the
      // raw response had model files but the direct-children filter dropped
      // them all (repo-root-relative vs folder-relative path shapes).
      const scope = rootOnly ? 'repo root' : folder !== undefined ? `path "/${folder}"` : 'repo'
      const versionsNote = versionIds.length > 0 ? ` (version filter: ${versionIds.join(', ')})` : ''
      console.warn(`[hub] diffusion entry "${d.name}" ${scope}${versionsNote} matched no files`)
      onProgress?.(
        `No files ${rootOnly ? 'at repo root' : folder !== undefined ? `under /${folder}` : 'in repo'} in ${d.url}${versionsNote}`
      )
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
          url: source.resolveUrl(repo, f.path),
          size: f.size,
          quant: quantFromName(f.path),
          repo: repo,
          provider: d.provider,
          // download-time routing key + provenance (see CatalogEntry.source)
          source: source.name,
          // Optional per-repo description from hub.json — conditional spread,
          // the same pattern the encoder / vision / vae loops use for their
          // optional fields.
          ...(d.description ? { description: d.description } : {})
        })
        dispatchedEntries++
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
    eligibleEntries++
    const source = getSourceForEntry(enc.url, enc.source ?? enc.domain)
    if (!source) {
      console.warn(`[hub] encoder entry "${diffusionType}" (${enc.url}): no model source for this URL's host — skipping`)
      continue
    }
    const repo = source.repoFromUrl(enc.url)
    // Bundle shape (`defaults[]`, SD3.5-style multi-encoder) vs single-file
    // shape (`default`). The normalization below dereferences `enc.default` /
    // `item.file`, so it must stay inside the branch that guarantees the
    // field exists — a bundle-only entry has no `default`, and an unguarded
    // `enc.default.replace(...)` here would crash the whole scan.
    const bundle =
      Array.isArray(enc.defaults) && enc.defaults.length > 0 ? enc.defaults : undefined
    // path -> use_as for the bundle files; `file` is normalized through the
    // source (its URL grammar) the same way `default` is — a full-URL form is
    // stripped to a repo-relative path, repo-relative values pass through.
    const bundleMap = new Map<string, string>()
    for (const item of bundle ?? []) {
      if (typeof item.file !== 'string' || item.file === '') continue
      const p = source.normalizeFilePath?.(item.file) ?? item.file
      bundleMap.set(p, item.use_as)
    }
    // `default` may be a full URL or a repo-relative path — normalize through
    // the source to repo-relative. Guarded: bundle-only entries carry no
    // `default`.
    const defaultPath =
      typeof enc.default === 'string' && enc.default !== ''
        ? (source.normalizeFilePath?.(enc.default) ?? enc.default)
        : undefined
    const files = await source.listFiles(repo)
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
        url: source.resolveUrl(repo, f.path),
        size: f.size,
        quant: quantFromName(f.path),
        repo,
        source: source.name,
        // the configured default file(s) may already be in the repo tree —
        // flag them so consumers can resolve them without a separate entry.
        // Bundle files additionally carry the `use_as` CLI flag name.
        ...(f.path === defaultPath ? { isDefault: true } : {}),
        ...(bundleUseAs !== undefined ? { isDefault: true, useAs: bundleUseAs } : {}),
        ...(enc.provider ? { provider: enc.provider } : {})
      })
      dispatchedEntries++
    }
    // ensure the configured default is present
    if (defaultPath !== undefined && !seen.has(defaultPath)) {
      const name = defaultPath.split('/').pop() ?? defaultPath
      const url = source.resolveUrl(repo, defaultPath)
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
        source: source.name,
        // provider selects the per-provider download subdirectory
        ...(enc.provider ? { provider: enc.provider } : {}),
        isDefault: true
      })
      dispatchedEntries++
    }
    // ensure every bundle file is present (the tree scan keeps only .gguf, so
    // .safetensors bundle files always come from this synthesis branch)
    for (const [p, useAs] of bundleMap) {
      if (seen.has(p)) continue
      const name = p.split('/').pop() ?? p
      const url = source.resolveUrl(repo, p)
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
        source: source.name,
        // provider selects the per-provider download subdirectory
        ...(enc.provider ? { provider: enc.provider } : {}),
        isDefault: true,
        useAs
      })
      dispatchedEntries++
    }
  }

  // vision (mmproj / projection model) — repo tree (.gguf) + the configured default file
  // `vision` is optional in HubConfig (absent when no diffusion type needs one).
  for (const [diffusionType, vis] of Object.entries(hub.repo.vision ?? {})) {
    onProgress?.(`Scanning ${vis.url}`)
    eligibleEntries++
    const source = getSourceForEntry(vis.url, vis.source ?? vis.domain)
    if (!source) {
      console.warn(`[hub] vision entry "${diffusionType}" (${vis.url}): no model source for this URL's host — skipping`)
      continue
    }
    const repo = source.repoFromUrl(vis.url)
    // `default` may be a full URL or a repo-relative path — normalize through the source
    const defaultPath = source.normalizeFilePath?.(vis.default) ?? vis.default
    const defaultName = defaultPath.split('/').pop() ?? defaultPath
    const defaultUrl = source.resolveUrl(repo, defaultPath)
    const files = await source.listFiles(repo)
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
        url: source.resolveUrl(repo, f.path),
        size: f.size,
        quant: quantFromName(f.path),
        repo,
        source: source.name,
        // the configured default file may already be in the repo tree —
        // flag it so consumers can resolve them without a separate entry
        ...(f.path === defaultPath ? { isDefault: true } : {}),
        ...(vis.provider ? { provider: vis.provider } : {})
      })
      dispatchedEntries++
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
        source: source.name,
        // provider selects the per-provider download subdirectory
        ...(vis.provider ? { provider: vis.provider } : {}),
        isDefault: true
      })
      dispatchedEntries++
    }
  }

  // tokenizer (optional map; one catalog entry per diffusion type) — like the
  // VAE loop, ONLY the configured default file is emitted (no repo tree scan):
  // tokenizer repos are full weights repos and a scan would flood the catalog
  // with irrelevant safetensors, while a tokenizer is a single small file
  // (e.g. tokenizer.json). A known source's headSize failure fails the whole
  // build, same as the vae/vision default-resolution paths.
  for (const [diffusionType, tok] of Object.entries(hub.repo.tokenizer ?? {})) {
    onProgress?.(`Scanning ${tok.url}`)
    eligibleEntries++
    const source = getSourceForEntry(tok.url, tok.source ?? tok.domain)
    if (!source) {
      console.warn(`[hub] tokenizer entry "${diffusionType}" (${tok.url}): no model source for this URL's host — skipping`)
      continue
    }
    const repo = source.repoFromUrl(tok.url)
    // `default` may be a full URL or a repo-relative path — normalize through the source
    const defaultPath = source.normalizeFilePath?.(tok.default) ?? tok.default
    const defaultName = defaultPath.split('/').pop() ?? defaultPath
    const defaultUrl = source.resolveUrl(repo, defaultPath)
    const size = await headSize(defaultUrl)
    entries.push({
      id: `tokenizer:${diffusionType}:${defaultName}`,
      type: 'tokenizer' as ModelType,
      diffusionType,
      name: defaultName,
      label: tok.label ?? defaultName,
      url: defaultUrl,
      size,
      quant: quantFromName(defaultName),
      source: source.name,
      // provider selects the per-provider download subdirectory
      ...(tok.provider ? { provider: tok.provider } : {}),
      isDefault: true
    })
    dispatchedEntries++
  }

  // lora (optional array; each entry may serve MULTIPLE diffusion types — one
  // catalog entry per `diffustion_types` member, so the per-type LoRA lists in
  // the renderer are exact while the download manager's dedupe-by-URL keeps a
  // shared file to a single fetch). Scan semantics are ALWAYS lenient: a
  // failing LoRA repo warns and contributes no rows, it never fails the whole
  // build (LoRAs are optional add-ons, unlike the weights the other loops
  // resolve).
  for (const l of hub.repo.lora ?? []) {
    // Same path normalization as the diffusion loop:
    // - "/TURBO" -> "TURBO", "./x/" -> "x" — that folder's direct children
    // - "/", "./" (or a bare ".") -> root-only scan — direct children of the
    //   repo root, no recursion
    // - absent/empty -> whole-repo recursive scan
    const raw = typeof l.path === 'string' ? l.path.trim() : ''
    const normalized = raw.replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
    const rootOnly = raw !== '' && (normalized === '' || normalized === '.')
    const folder = rootOnly ? '' : normalized || undefined
    // Optional CivitAI version filter (hub.json `model_version_ids`) — the
    // same defensive shape-check as the diffusion loop (the bundled config is
    // loaded without validation; a malformed value degrades to "no filter").
    const versionIds = Array.isArray(l.model_version_ids)
      ? l.model_version_ids.filter((n) => typeof n === 'number' && Number.isFinite(n))
      : []
    // Optional pagination cap (hub.json `max_page`, HF entries) — the same
    // defensive shape-check as the diffusion loop.
    const maxPage =
      typeof l.max_page === 'number' && Number.isFinite(l.max_page) && l.max_page >= 1
        ? Math.floor(l.max_page)
        : undefined
    // `diffustion_types` drives the per-type expansion — defensively
    // shape-checked for the same unvalidated-bundled-config reason.
    const types = Array.isArray(l.diffustion_types)
      ? l.diffustion_types.filter((t) => typeof t === 'string' && t !== '')
      : []
    if (types.length === 0) {
      console.warn(`[hub] lora entry "${l.label ?? l.url}" has no usable diffustion_types; skipping`)
      continue
    }
    onProgress?.(`Scanning ${l.url}`)
    eligibleEntries++
    const source = getSourceForEntry(l.url, l.source ?? l.domain)
    if (!source) {
      console.warn(`[hub] lora entry "${l.label}" (${l.url}): no model source for this URL's host — skipping`)
      continue
    }
    const repo = source.repoFromUrl(l.url)
    let scanned: RepoFile[]
    try {
      scanned = await source.listFiles(
        repo,
        folder,
        versionIds.length > 0 || maxPage !== undefined ? { versionIds, maxPage } : undefined
      )
    } catch (e) {
      // Lenient by design (see the loop comment): a LoRA repo failing to scan
      // never fails the catalog build.
      console.warn(
        `[hub] lora entry "${l.label}" (${l.url}) scan failed (${(e as Error).message}); contributing no rows`
      )
      onProgress?.(`Scan failed for ${l.url} — skipping`)
      continue
    }
    if ((folder !== undefined || versionIds.length > 0) && scanned.length === 0) {
      const scope = rootOnly ? 'repo root' : folder !== undefined ? `path "/${folder}"` : 'repo'
      const versionsNote = versionIds.length > 0 ? ` (version filter: ${versionIds.join(', ')})` : ''
      console.warn(`[hub] lora entry "${l.label}" ${scope}${versionsNote} matched no files`)
      onProgress?.(`No files in ${l.url}${versionsNote}`)
    }
    for (const f of scanned) {
      const ext = f.path.toLowerCase()
      if (!ext.endsWith('.gguf') && !ext.endsWith('.safetensors')) continue
      // LoRA storage nests per provider under models/lora/, but the app never
      // resolves a LoRA path at spawn (sd-cli scans --lora-model-dir itself),
      // and installed-state matching compares catalog names against the
      // basenames `models.list('lora')` returns — so the name is ALWAYS the
      // basename, even for whole-repo scans whose paths carry slashes.
      const name = f.path.split('/').pop() ?? f.path
      for (const dt of types) {
        entries.push({
          id: `lora:${dt}:${f.path}`,
          type: 'lora' as ModelType,
          diffusionType: dt,
          // The hub entry's human label ("ENI Pattern") beats the file
          // basename; the ?? guards an unvalidated bundled config.
          name,
          label: l.label ?? name,
          url: source.resolveUrl(repo, f.path),
          size: f.size,
          quant: quantFromName(f.path),
          repo,
          provider: l.provider,
          // download-time routing key + provenance (see CatalogEntry.source)
          source: source.name,
          ...(l.description ? { description: l.description } : {})
        })
        dispatchedEntries++
      }
    }
  }

  // vae (repo + default file; the legacy plain-URL form is still accepted)
  for (const [diffusionType, v] of Object.entries(hub.repo.vae)) {
    if (typeof v === 'string') {
      // Legacy plain-URL form: stored VERBATIM — no source dispatch, no
      // normalization, no resolveUrl (deriving a path from a *file* URL and
      // re-resolving it would double-prefix `resolve/main/` or otherwise
      // change the entry URL). No source stamp either: download-time routing
      // degrades to URL-host matching, which resolves HF correctly.
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
    eligibleEntries++
    const source = getSourceForEntry(v.url, v.source ?? v.domain)
    if (!source) {
      console.warn(`[hub] vae entry "${diffusionType}" (${v.url}): no model source for this URL's host — skipping`)
      continue
    }
    const repo = source.repoFromUrl(v.url)
    // `default` may be a full URL or a repo-relative path — normalize through the source
    const defaultPath = source.normalizeFilePath?.(v.default) ?? v.default
    const name = defaultPath.split('/').pop() ?? defaultPath
    const vaeUrl = source.resolveUrl(repo, defaultPath)
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
      source: source.name,
      // provider selects the per-provider download subdirectory
      ...(v.provider ? { provider: v.provider } : {}),
      isDefault: true
    })
    dispatchedEntries++
  }

  // P2.3 tripwire: a source-dispatched build that produced ZERO entries while
  // the hub config had at least one dispatch-eligible entry means the source
  // registry was never populated (import-wiring regression — the lenient
  // unknown-source policy turns that into warn + skip for every row, i.e. a
  // silent empty catalog). Say so LOUDLY, once per build, pointing at the
  // wiring contract.
  if (dispatchedEntries === 0 && eligibleEntries > 0) {
    console.error(
      `[hub] catalog build dispatched 0 entries through any model source while ${eligibleEntries} hub entries were dispatch-eligible — the source registry is empty. 'src/main/services/sources/index.ts' must be imported before the first buildCatalog() call so registerSources() runs (hub.ts and models.ts both import './sources'); see plans/model-downloader-source.md §"File changes" (P2.3).`
    )
  }

  const catalog: HubCatalog = {
    scannedAt: Date.now(),
    // App identity now lives in application.json (hub.json no longer carries `name`).
    source: loadApplicationConfig().name,
    entries
  }
  return catalog
}

/**
 * The stamped model-source name for a download URL, read from the CACHED
 * catalog (hub-catalog.json) — the download-time routing hint consumed by
 * models.ts's `resolveSourceForUrl`. Matched by EXACT string equality against
 * `CatalogEntry.url` (the renderer passes the entry's URL verbatim into
 * `models:download` — no normalization — trimming, trailing-slash folding,
 * case folding — may be applied on either side, or a stored entry silently
 * stops matching its own download URL and degrades to host matching).
 * Returns undefined on a missing/corrupt cache, a URL miss, or an unstamped
 * (legacy plain-URL VAE) entry.
 */
export function catalogSourceForUrl(url: string): string | undefined {
  return catalogEntryForUrl(url)?.source
}

/**
 * The cached catalog entry for a download URL — the shared exact-URL lookup
 * behind `catalogSourceForUrl` (the routing hint) and `catalogNameForUrl`
 * (the stored-filename override). One parse, two consumers, so the two
 * lookups can never disagree about WHICH entry a URL belongs to.
 */
function catalogEntryForUrl(url: string): CatalogEntry | undefined {
  const p = catalogPath()
  if (!existsSync(p)) return undefined
  let catalog: HubCatalog
  try {
    catalog = JSON.parse(readFileSync(p, 'utf-8')) as HubCatalog
  } catch {
    return undefined
  }
  return catalog.entries?.find((e) => e.url === url)
}

/**
 * The catalog entry's `name` for a download URL — the stored-filename
 * override threaded by models.ts's `downloadViaSource` into
 * `DownloadParams.filename` / the anonymous `downloadModel` fallback.
 * Exists for sources whose download URLs carry no filename in the path
 * (CivitAI's `/api/download/models/<versionId>` — the URL basename is a
 * bare version ID that `gen:start`'s extension-filtered basename matching
 * could never resolve). Same exact-URL-match semantics as
 * `catalogSourceForUrl`; undefined on a missing/corrupt cache or a URL miss
 * (the manager then falls back to the URL basename — the pre-existing HF
 * behavior).
 */
export function catalogNameForUrl(url: string): string | undefined {
  return catalogEntryForUrl(url)?.name
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
