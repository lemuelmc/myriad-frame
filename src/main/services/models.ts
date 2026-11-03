/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ModelFile, ModelType } from '@shared/types'
import { downloadModel, setModelDownloadFn } from './downloads'
// The source registry (importing './sources' also populates it at module
// load) + the cached catalog's stamped-source lookup for the routing hint.
import { getSourceForUrl, getSourceForEntry } from './sources'
import { catalogSourceForUrl, catalogNameForUrl } from './hub'
import type { ModelSource } from './sources/model-source'

/**
 * Ensure the canonical data/models layout exists, migrating the legacy
 * `difussion` folder to `diffusion` if present.
 */
import { dataRoot } from './data'

export function ensureModelDirs(): void {
  const root = join(dataRoot(), 'models')
  for (const t of ['diffusion', 'encoder', 'vae', 'vision', 'lora', 'tokenizer'] as const) {
    mkdirSync(join(root, t), { recursive: true })
  }
  const legacy = join(root, 'difussion')
  if (existsSync(legacy)) {
    const target = join(root, 'diffusion')
    for (const f of readdirSync(legacy)) {
      const from = join(legacy, f)
      const to = join(target, f)
      if (!existsSync(to)) renameSync(from, to)
    }
    rmSync(legacy, { recursive: true, force: true })
  }
}

export function modelsDir(type: ModelType): string {
  return join(dataRoot(), 'models', type)
}

export interface ModelsService {
  list: (type: ModelType) => ModelFile[]
  /**
   * Download a model. `provider` selects the per-provider subdirectory under
   * `data/models/<type>/` (e.g. 'unsloth' → `data/models/diffusion/unsloth/`).
   * Falls back to the legacy flat layout when omitted.
   */
  download: (type: ModelType, url: string, onProgress: (downloadedBytes: number, totalBytes: number) => void, provider?: string, force?: boolean) => Promise<string>
  remove: (type: ModelType, name: string) => void
  pathFor: (type: ModelType, name: string, provider?: string) => string
}

/**
 * The shared routing-precedence resolver — ONE home for the precedence so
 * `downloadViaSource` AND the auth follow-up's `authHeadersForUrl` (which
 * resolves the source again for the `models:verify` probe) can never drift.
 * Precedence: (1) the entry's stamped source name — the post-override
 * resolution made at catalog-build time, read from the CACHED catalog via
 * catalogSourceForUrl(url) — which covers sources whose file URLs are hosted
 * outside their declared `domains`; (2) plain URL-host matching. Returns
 * `undefined` when neither resolves (each caller decides its own fallback).
 * The stamp is read from the cache (not threaded through IPC or the download
 * registry), so the IPC path AND startAllPending() retries resolve it
 * identically with zero extra plumbing. A stale/unregistered hint degrades to
 * host matching; a legacy pre-refactor cache (no source stamps) degrades to
 * host matching = the pre-refactor behavior.
 */
export function resolveSourceForUrl(url: string): ModelSource | undefined {
  const hint = catalogSourceForUrl(url)
  return (hint ? getSourceForEntry(url, hint) : undefined) ?? getSourceForUrl(url)
}

/**
 * The single source-aware model-download chokepoint. Used by the
 * `models:download` IPC path (via ModelsService.download) AND by
 * downloads.ts.startAllPending background retries (through the
 * `modelDownloadFn` hook installed below), so every model download consults
 * the source registry.
 */
export async function downloadViaSource(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean
): Promise<string> {
  // Stored-filename override, read from the CACHED catalog by exact URL
  // match — the same lookup pattern as the source stamp above. Needed by
  // sources whose download URLs carry no filename in the path (CivitAI's
  // `/api/download/models/<versionId>` — the URL basename is a bare version
  // ID the manager's extensionless `entryName` fallback could never resolve
  // for gen:start). Read here — NOT threaded through IPC — so the
  // `models:download` path AND startAllPending() background retries resolve
  // it identically with zero extra plumbing. Undefined on a cache miss → the
  // manager falls back to the URL basename (the pre-existing HF behavior).
  const filename = catalogNameForUrl(url)
  const source = resolveSourceForUrl(url)
  if (source) {
    // org/repo slug, derived by the source itself (repoFromUrl — the inverse
    // of resolveUrl) so the auth follow-up (model-downloader-auth.md) looks
    // tokens up by this exact slug. A generic scheme+host strip would be
    // WRONG here: `url` is the file download URL (CatalogEntry.url), so
    // stripping scheme + host yields `org/repo/resolve/main/<file>`, not
    // `org/repo`.
    const repo = source.repoFromUrl(url)
    return source.download({
      url,
      repo,
      type,
      provider,
      force,
      filename
      // destPath / onProgress / signal omitted — the default delegation ignores
      // all three (the manager owns progress broadcast + abort; see the
      // source plan §2)
    })
  }
  return downloadModel(type, url, provider, force, { filename })
}

/**
 * Auth headers for an out-of-band probe of `url` — currently the
 * `models:verify` installed-file check in ipc.ts, which calls `headSize`
 * directly OUTSIDE the download manager, so the two in-manager header threads
 * never reach it. Resolves the source through the SAME `resolveSourceForUrl`
 * precedence helper `downloadViaSource` uses — one home for the precedence,
 * no drift — derives the repo slug via `source.repoFromUrl(url)` and returns
 * the source's auth headers. Returns {} when no source matches, the source
 * has no hook, or the auth layer throws (catch → {} — the verify path must
 * never reject because of auth; an anonymous probe falls back to the
 * pre-existing `expected === 0 → ok` semantics).
 *
 * Lives in models.ts, NOT in sources/: hub.ts imports './sources', so a
 * sources → hub back-edge (for catalogSourceForUrl) would cycle the
 * load-time source registration that the source plan's P2.3 warning protects.
 */
export async function authHeadersForUrl(url: string): Promise<Record<string, string>> {
  try {
    const source = resolveSourceForUrl(url)
    if (!source?.getAuthHeaders) return {}
    const repo = source.repoFromUrl(url)
    return (await source.getAuthHeaders(repo)) ?? {}
  } catch {
    return {}
  }
}

// Module scope — runs at import time, before the first startAllPending() call
// in index.ts (index.ts imports ipc.ts, which imports models.ts, and all
// module loads precede app.whenReady()). This ordering is load-bearing: if
// models.ts were first imported after startAllPending() ran, background
// retries would bypass the source. The hook lives ON the globalThis
// DownloadsState (never a module-scope variable), so it is visible to every
// downloads.ts module copy; models.ts itself may also be double-instantiated,
// which is benign — both copies' downloadViaSource are behaviorally
// identical (they consult the same globalThis-backed source registry and
// call downloadModel on copies that share the same globalThis DownloadsState),
// and the last registration wins.
setModelDownloadFn(downloadViaSource)

export function createModelsService(): ModelsService {
  function list(type: ModelType): ModelFile[] {
    const dir = modelsDir(type)
    if (!existsSync(dir)) return []
    const out: ModelFile[] = []
    const statFile = (p: string, name: string): ModelFile | null => {
      // A file may be locked/locked-in-use (e.g. an active generation holds
      // it open on Windows), which makes `statSync` throw EPERM. Skip such
      // files rather than aborting the whole listing.
      try {
        const st = statSync(p)
        if (!st.isFile()) return null
        return { name, size: st.size, modifiedAt: st.mtimeMs }
      } catch {
        return null
      }
    }
    // legacy flat files (pre-provider-nesting installs)
    for (const name of readdirSync(dir)) {
      const f = statFile(join(dir, name), name)
      if (f) out.push(f)
    }
    // per-provider subdirectories
    for (const entry of readdirSync(dir)) {
      const sub = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(sub).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      for (const name of readdirSync(sub)) {
        const f = statFile(join(sub, name), name)
        if (f) out.push(f)
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async function download(
    type: ModelType,
    url: string,
    _onProgress: (downloadedBytes: number, totalBytes: number) => void,
    provider = 'default',
    force = false
  ): Promise<string> {
    // Route through the source-aware chokepoint: the resolved model source
    // (stamped CatalogEntry.source hint first, then URL-host match) owns the
    // download; a URL with no matching source falls through to the plain
    // manager call (a strict superset of the pre-source behavior). The
    // manager remains the sole source of model progress (models.ts does not
    // broadcast).
    return downloadViaSource(type, url, provider, force)
  }

  function remove(type: ModelType, name: string): void {
    const dir = modelsDir(type)
    // legacy flat location
    if (existsSync(join(dir, name))) rmSync(join(dir, name), { force: true })
    // per-provider subdirectories
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry, name)
        if (existsSync(p)) rmSync(p, { force: true })
      }
    }
  }

  /**
   * Resolve a model file to an absolute path. Matches by basename across the
   * per-provider subdirectories (new layout) and the legacy flat location
   * (backward compatibility), returning the first existing match.
   *
   * When `provider` is supplied, the provider-specific subdirectory is checked
   * first so a basename collision across providers (e.g. `diffusion_pytorch_model.safetensors`
   * under both `black_forest_labs` and `huaweilin` for sd3_5) resolves to the
   * provider configured in hub.json instead of whichever folder sorts first.
   */
  function pathFor(type: ModelType, name: string, provider?: string): string {
    const dir = modelsDir(type)
    const base = basename(name)
    const flat = join(dir, name)
    if (existsSync(flat)) return flat
    if (existsSync(dir)) {
      // Per-provider subdirectories, checked in a stable order: the requested
      // provider first (so the hub.json-configured VAE/encoder/encoder wins),
      // then any remaining folders in a deterministic order.
      const entries = readdirSync(dir).sort((a, b) => a.localeCompare(b))
      const ordered = provider ? [provider, ...entries.filter((e) => e !== provider)] : entries
      for (const entry of ordered) {
        const p = join(dir, entry, base)
        if (existsSync(p)) return p
      }
    }
    return flat
  }

  return { list, download, remove, pathFor }
}
