/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { CatalogEntry, CompanionKind, CompanionRef } from '@shared/types'
import { COMPANION_USE_AS_DEFAULTS } from '@shared/types'
import { useAppStore } from './stores/app'

/**
 * The companion references for a diffusion type + kind — one { from, useAs }
 * per companion file, resolved from the hub entry's `requires.<kind>` block
 * (scalar → single item under the kind's default flag; array → one item per
 * entry). Read from the FRESH hub config (`app:configs`) the same way
 * `resolveEncoderBundle` reads `defaults[]`; `requires` is per hub ENTRY,
 * so the FIRST `repo.diffusion` entry with the requested diffusion_type
 * wins (each wan family maps to exactly one entry today; the catalog stamp
 * on the selected entry is the per-entry truth where one exists).
 *
 * NEVER empty: when the hub entry declares no `requires.<kind>` — or no
 * `repo.diffusion` entry matches — the FALLBACK `[{ from: diffusionType,
 * useAs: <kind default> }]` is returned, so every caller can use
 * `comps[0].from` directly (the diffusion type itself — exactly what the
 * old `requiredFamilyFor` returned).
 */
export function requiredCompanionsFor(
  diffusionType: string,
  kind: CompanionKind,
  hubName?: string
): CompanionRef[] {
  const appStore = useAppStore()
  const entries = appStore.configs?.hub.repo.diffusion ?? []
  // A family may map to SEVERAL hub entries (multiple providers); the hub
  // entry `name` (CatalogEntry.hubName — the session's `diffusionName`) pins
  // the exact entry when present, falling back to the first family match.
  const entry =
    (hubName
      ? entries.find((d) => d.family === diffusionType && d.name === hubName)
      : undefined) ?? entries.find((d) => d.family === diffusionType)
  const raw = entry?.requires?.[kind]
  const fallback: CompanionRef[] = [{ from: diffusionType, useAs: COMPANION_USE_AS_DEFAULTS[kind] }]
  if (!raw) return fallback
  const items = Array.isArray(raw) ? raw : [raw]
  const out: CompanionRef[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.from !== 'string' || it.from === '') continue
    const io = it as { from: string; use_as?: string }
    out.push({ from: io.from, useAs: io.use_as || COMPANION_USE_AS_DEFAULTS[kind] })
  }
  return out.length > 0 ? out : fallback
}

/**
 * The hub.json diffusion entry `name` for a catalog row (e.g.
 * `comfy_org_boogu_image`) — the value a session persists as `diffusionName`
 * and the gen:start request carries to pin the exact hub entry. The stamped
 * `CatalogEntry.hubName` wins when the catalog cache carries it (post-rescan);
 * otherwise it is derived from the FRESH hub config by family + provider
 * (falling back to the first family entry), so the field populates
 * immediately even while the cached catalog predates the stamp.
 */
export function hubEntryNameFor(e: CatalogEntry): string | undefined {
  const appStore = useAppStore()
  const pool = appStore.configs?.hub.repo.diffusion ?? []
  if (e.hubName) return e.hubName
  const byProvider = e.provider
    ? pool.find((d) => d.family === e.diffusionType && d.provider === e.provider)
    : undefined
  return (byProvider ?? pool.find((d) => d.family === e.diffusionType))?.name
}

/**
 * The access requirement stamped on a diffusion family in hub.json
 * (`model_families[].access`): 'auth' = downloads require an API token,
 * 'gated' = a token PLUS accepting the terms/license on the model page.
 * Read from the FRESH hub config (`app:configs`) — the same stale-cache
 * immunity as `requiredCompanionsFor` — so a newly configured family badges
 * immediately, without a catalog rescan. `undefined` = freely downloadable.
 */
export function accessForFamily(diffusionType: string): 'auth' | 'gated' | undefined {
  const appStore = useAppStore()
  const models = appStore.configs?.hub.model_families ?? []
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

/**
 * The array-form `requires.encoder` bundle for a diffusion type — one full
 * EncoderBundleEntry per companion item, each resolved from its OWN `from`
 * family (the single-file `repo.encoder[from].default`, or the `defaults[]`
 * item matching the item's `use_as`), stamped with the item's `useAs` as the
 * CLI flag and the `from` family as its `diffusionType` — the exact per-item
 * construction the old `resolveRequiredEncoders` performed, only driven by
 * the companion array (`requiredCompanionsFor`) instead of re-reading the raw
 * requires block.
 *
 * Returns `[]` when the companions do NOT describe a genuine array form — a
 * single item whose useAs is the kind default ('llm') is semantically the
 * scalar form and routes through the from-family's NORMAL encoder resolution
 * instead (which also honors the user's defaultEncoder setting, which the
 * bundle path bypasses). When that `from` family is a `defaults[]` BUNDLE
 * family, the normal resolution yields the family's FULL bundle under its own
 * flags — the same set the main-side fan-out's scalar-encoder rule downloads,
 * so the renderer and the fan-out stay coherent.
 */
export function requiredEncoderBundle(dt: string, hubName?: string): EncoderBundleEntry[] {
  const comps = requiredCompanionsFor(dt, 'encoder', hubName)
  if (comps.length <= 1 && comps[0].useAs === COMPANION_USE_AS_DEFAULTS.encoder) return []
  const appStore = useAppStore()
  const catalog = appStore.catalog?.entries ?? []
  const out: EncoderBundleEntry[] = []
  for (const comp of comps) {
    const from = comp.from
    const useAs = comp.useAs
    const encCfg = appStore.configs?.hub.repo.encoder[from]
    // The `from` family must declare the file (single-file `default` or a
    // `defaults[]` bundle). A missing/invalid entry is skipped rather than
    // crashing the bundle.
    if (!encCfg || typeof encCfg.url !== 'string' || encCfg.url === '') continue
    let file: string | undefined
    if (Array.isArray(encCfg.defaults) && encCfg.defaults.length > 0) {
      const match = encCfg.defaults.find((d) => d.use_as === useAs) ?? encCfg.defaults[0]
      file = match.file
    } else if (typeof encCfg.default === 'string') {
      file = encCfg.default
    }
    if (!file) continue
    // `file` may be a full URL or a repo-relative path — normalize to
    // repo-relative the same way `resolveEncoderBundle` / buildCatalog() do.
    const path = file
      .replace(/^https?:\/\/[^/]+\/[^/]+\/resolve\/main\//, '')
      .replace(/^\//, '')
    const name = path.split('/').pop() ?? path
    const repoUrl = encCfg.url
      .replace(/\/(tree|blob)\/[^/]+\/?$/, '')
      .replace(/\/+$/, '')
    const url = `${repoUrl}/resolve/main/${path}`
    const hit =
      catalog.find((e) => e.type === 'encoder' && e.diffusionType === from && e.url === url) ??
      catalog.find((e) => e.type === 'encoder' && e.diffusionType === from && e.name === name)
    out.push({
      id: `encoder:${from}:${name}`,
      type: 'encoder',
      diffusionType: from,
      name,
      label: name,
      url,
      ...(hit?.size !== undefined ? { size: hit.size } : {}),
      ...(hit?.quant !== undefined ? { quant: hit.quant } : {}),
      ...(encCfg.provider ? { provider: encCfg.provider } : {}),
      isDefault: true,
      useAs
    })
  }
  return out
}
