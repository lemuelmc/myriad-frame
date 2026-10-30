/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { CatalogEntry, HubProvider } from '@shared/types'

/**
 * Shared search helpers for model lists (ModelPickerDialog, SettingsDialog →
 * Models). Kept in one module so the normalization rules and the matched
 * haystack list cannot drift between consumers.
 */

/** Space, underscore and hyphen are interchangeable separators when searching. */
const SEPARATOR_RE = /[\s_-]+/g

/**
 * Lowercase and collapse separator runs to single spaces so "z-image",
 * "z image" and "z_image" all match a model named "z_image…".
 */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(SEPARATOR_RE, ' ')
}

/**
 * Resolve a provider key (e.g. 'unsloth') to its human-readable label using
 * the top-level `providers` map in hub.json. Falls back to the key itself, or
 * 'Unknown' when no provider key is present.
 */
export function providerLabel(key: string | undefined, providers: HubProvider[]): string {
  if (!key) return 'Unknown'
  for (const p of providers) {
    // `HubProvider` is a flat `{ name, label }` entry (matching the actual
    // hub.json data), so match on `p.name` — the previous hasOwnProperty
    // lookup against a wrong index-signature shape silently fell back to
    // the raw key for every provider.
    if (p.name === key) return p.label
  }
  return key
}

/**
 * Case-insensitive match across name, label (typically the full repo path for
 * diffusion entries, so path segments are searchable — folder-restricted
 * entries surface the bare basename instead), quant, provider label,
 * description, and diffusionType (the Family column). Both the query and the
 * haystacks pass through `normalizeForSearch`, which makes the separator
 * characters (space, underscore, hyphen) equivalent on both sides.
 *
 * `providers` is the `hub.providers` list used to resolve `e.provider` keys to
 * their human-readable labels for matching (a plain module must not reach into
 * the Pinia store, so callers thread it through explicitly).
 */
export function matchesSearch(e: CatalogEntry, q: string, providers: HubProvider[]): boolean {
  const needle = normalizeForSearch(q)
  const haystacks = [e.name, e.label, e.quant, providerLabel(e.provider, providers), e.description, e.diffusionType]
  return haystacks.some((h) => normalizeForSearch(h ?? '').includes(needle))
}
