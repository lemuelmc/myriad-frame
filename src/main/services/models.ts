/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ModelFile, ModelType } from '@shared/types'
import { downloadModel } from './downloads'

/**
 * Ensure the canonical data/models layout exists, migrating the legacy
 * `difussion` folder to `diffusion` if present.
 */
import { dataRoot } from './data'

export function ensureModelDirs(): void {
  const root = join(dataRoot(), 'models')
  for (const t of ['diffusion', 'encoder', 'vae', 'vision'] as const) {
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
    // Delegate to the download manager, which stages the download in
    // data/tmp/, size-verifies it, then moves it into place. The manager is
    // the sole source of model progress (models.ts no longer broadcasts).
    return downloadModel(type, url, provider, force)
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
