/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { CatalogEntry } from '@shared/types'
import { useAppStore } from './stores/app'

/**
 * The diffusion family a companion model (VAE / text encoder / audio
 * encoder) resolves from for a diffusion type — the hub entry's
 * `requires.<kind>.from` when present, else the diffusion type itself.
 * Read from the FRESH hub config (`app:configs`) the same way
 * `resolveEncoderBundle` reads `defaults[]`; `requires` is per hub ENTRY,
 * so the FIRST `repo.diffusion` entry with the requested diffusion_type
 * wins (each wan family maps to exactly one entry today; the catalog stamp
 * on the selected entry is the per-entry truth where one exists).
 */
export function requiredFamilyFor(
  diffusionType: string,
  kind: 'vae' | 'encoder' | 'audio_encoder'
): string {
  const appStore = useAppStore()
  const entries = appStore.configs?.hub.repo.diffusion ?? []
  const entry = entries.find((d) => d.diffusion_type === diffusionType)
  const from = entry?.requires?.[kind]?.from
  return typeof from === 'string' && from !== '' ? from : diffusionType
}

/**
 * The access requirement stamped on a diffusion family in hub.json
 * (`diffusion_models[].access`): 'auth' = downloads require an API token,
 * 'gated' = a token PLUS accepting the terms/license on the model page.
 * Read from the FRESH hub config (`app:configs`) — the same stale-cache
 * immunity as `requiredFamilyFor` — so a newly configured family badges
 * immediately, without a catalog rescan. `undefined` = freely downloadable.
 */
export function accessForFamily(diffusionType: string): 'auth' | 'gated' | undefined {
  const appStore = useAppStore()
  const models = appStore.configs?.hub.diffusion_models ?? []
  const access = models.find((m) => m.name === diffusionType)?.access
  return access === 'auth' || access === 'gated' ? access : undefined
}

/** A bundle descriptor: a full catalog entry plus the guaranteed `useAs` flag name. */
export type EncoderBundleEntry = CatalogEntry & { useAs: string }

/**
 * Resolve the encoder bundle for a diffusion type from the hub config — the
 * source of truth, always fresh via `app:configs`, so SD3.5 works immediately
 * even while the cached catalog (`data/cache/hub-catalog.json`) is stale.
 *
 * Builds one full `CatalogEntry`-shaped descriptor per `defaults[]` item:
 * downstream consumers depend on the complete shape (`type: 'encoder'` feeds
 * straight into `ensureDownloaded` → `downloadModel` / `modelsVerify` /
 * `isInstalled`). `name` / `label` are the file basename (matching the
 * on-disk name `downloadModel` derives from the URL basename, so `pathFor()`
 * resolves the descriptor after download). The descriptor is enriched with
 * `size` / `quant` from the cached catalog when a matching entry exists
 * (matched by `url` — stable across rescans — falling back to the basename);
 * that enrichment is display sugar only, not a correctness dependency.
 *
 * Returns `[]` when the encoder entry has no `defaults` (single-file types
 * keep the existing resolution flow).
 */
export function resolveEncoderBundle(dt: string): EncoderBundleEntry[] {
  const appStore = useAppStore()
  const enc = appStore.configs?.hub.repo.encoder[dt]
  // A bundle without a usable repo URL cannot produce resolve URLs — treat
  // it as no bundle rather than crashing the renderer.
  if (!enc || typeof enc.url !== 'string' || enc.url === '') return []
  if (!Array.isArray(enc.defaults) || enc.defaults.length === 0) return []
  const catalog = appStore.catalog?.entries ?? []
  const out: EncoderBundleEntry[] = []
  for (const item of enc.defaults) {
    // `file` may be a full URL or a repo-relative path — normalize to
    // repo-relative the same way buildCatalog() does, then compose the
    // resolve URL from the configured repo URL.
    const path = item.file
      .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
      .replace(/^\//, '')
    const name = path.split('/').pop() ?? path
    // Strip a trailing `/tree/<ref>` (or `/blob/<ref>`) UI suffix from the
    // configured repo URL first — composing `.../tree/main/resolve/main/...`
    // yields a broken download URL (F9; the hub.json root fix landed with the
    // collision-hardening change, this stays as defense-in-depth for a future
    // URL carrying the suffix).
    const repoUrl = enc.url
      .replace(/\/(tree|blob)\/[^/]+\/?$/, '')
      .replace(/\/+$/, '')
    const url = `${repoUrl}/resolve/main/${path}`
    const hit =
      catalog.find((e) => e.type === 'encoder' && e.diffusionType === dt && e.url === url) ??
      catalog.find((e) => e.type === 'encoder' && e.diffusionType === dt && e.name === name)
    out.push({
      id: `encoder:${dt}:${name}`,
      type: 'encoder',
      diffusionType: dt,
      name,
      label: name,
      url,
      // display enrichment from the cached catalog when available
      ...(hit?.size !== undefined ? { size: hit.size } : {}),
      ...(hit?.quant !== undefined ? { quant: hit.quant } : {}),
      ...(enc.provider ? { provider: enc.provider } : {}),
      isDefault: true,
      useAs: item.use_as
    })
  }
  return out
}
