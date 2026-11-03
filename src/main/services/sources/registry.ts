/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { ModelSource } from './model-source'

/**
 * The registry lives on `globalThis`, mirroring the downloads.ts singleton:
 * the main bundle has been observed to instantiate modules twice (see the
 * comment in downloads.ts), and a module-scope Map would split the registry
 * between instances — one populated, one empty — leaving an empty catalog
 * and no auth headers on the second instance's downloads.
 */
const globalForSources = globalThis as typeof globalThis & {
  __myriadFrameSourceRegistry?: Map<string, ModelSource>
}
const registry: Map<string, ModelSource> =
  (globalForSources.__myriadFrameSourceRegistry ??= new Map())

/**
 * Register a source under BOTH its domains and its `name`, so an override can
 * be either a domain (`huggingface.co`) or a source name (`huggingface`).
 */
export function registerSource(source: ModelSource): void {
  for (const d of source.domains) {
    // Warn only on a real conflict — two DIFFERENT sources claiming one domain.
    // Re-registration of the same source name (what the documented module
    // double-instantiation produces) is benign and stays silent.
    const prev = registry.get(d)
    if (prev && prev.name !== source.name) {
      console.warn(
        `[sources] domain "${d}" already claimed by "${prev.name}"; overwriting with "${source.name}"`
      )
    }
    registry.set(d, source)
  }
  // The name-key write warns ONLY on a genuine same-name collision — an
  // existing entry under this name whose CLASS differs from the arriving
  // one. The documented module double-instantiation (two instances of the
  // SAME class) must stay silent: instances from two module copies have
  // distinct constructor OBJECTS but the same constructor NAME, so the
  // comparison is on `constructor.name`, not identity — a same-class
  // duplicate is silent, while a copy-paste wiring error (two different
  // classes registered under one name from the canonical `registerSources()`)
  // warns loudly. Cheap static-wiring guard, not exhaustive: two distinct
  // classes sharing a constructor name would false-negative, but that
  // requires deliberately adversarial naming.
  const prevByName = registry.get(source.name)
  if (prevByName && prevByName.constructor.name !== source.constructor.name) {
    console.warn(
      `[sources] name "${source.name}" already registered by a different class ("${prevByName.constructor.name}"); overwriting with "${source.constructor.name}"`
    )
  }
  registry.set(source.name, source)
}

/** Pick the source for a repo URL by matching the URL's hostname. */
export function getSourceForUrl(url: string): ModelSource | undefined {
  try {
    return registry.get(new URL(url).hostname)
  } catch {
    return undefined
  }
}

/**
 * Resolve the source for a repo entry: an explicit override (a domain or a
 * source name — the registry is keyed by both) wins if present, else
 * domain-match the repo URL. Returns `undefined` when nothing matches
 * (surfaced as a per-entry warning, not a catalog crash).
 */
export function getSourceForEntry(url: string, override?: string): ModelSource | undefined {
  if (override) return registry.get(override)
  return getSourceForUrl(url)
}

/**
 * Registered source NAMES, deduped — the registry map is keyed by BOTH
 * domains ("huggingface.co") and names ("huggingface"), so a naive key
 * listing would show both. Dedupe by `source.name`. Consumed by the
 * Settings → Tokens UI (via the `sources:list` IPC) to populate the source
 * dropdown and to reject tokens for unregistered sources at add/import time.
 */
export function sourceNames(): string[] {
  const byName = new Map<string, ModelSource>()
  for (const [, source] of registry) byName.set(source.name, source)
  return Array.from(byName.keys())
}
