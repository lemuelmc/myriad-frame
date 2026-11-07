/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright is preserved.
 */

import type { ConfigUpdateStatus, HubConfig, RuntimeConfig } from '@shared/types'
import { fetchText } from './download'
import {
  loadHubConfig,
  loadRuntimeConfig,
  normalizeRuntimeConfig,
  readHubOverride,
  readRuntimeOverride,
  validateHubConfig,
  validateRuntimeConfig
} from './config'

/** Raw source of the up-to-date runtime config (Settings → Runtime → Check and the launch-time update check). */
const RUNTIME_CONFIG_URL =
  'https://raw.githubusercontent.com/lemuelmc/myriad-frame/master/configurations/runtime.json'

/** Raw source of the up-to-date hub config (Settings → Models → Check and the launch-time update check). */
const HUB_CONFIG_URL =
  'https://raw.githubusercontent.com/lemuelmc/myriad-frame/master/configurations/hub.json'

/**
 * Recursively sort object keys before stringifying, so the update checks'
 * comparison is key-order-stable: a plain `JSON.stringify` is order-sensitive
 * and would report a spurious "updated" (plus a backup) whenever upstream
 * reorders keys with identical content.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableStringify))
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** Outcome of one remote-config check: whether it differs from the active config. */
export interface RemoteConfigCheck<T> {
  changed: boolean
  remote: T
  current: T
}

/**
 * Fetch the remote runtime config and compare it against the active one
 * (valid override, else bundled). Detect-only: nothing is written. Throws on
 * a corrupt local override (before fetching — nothing is touched), a fetch
 * failure, or an invalid remote shape, with the same specific messages the
 * `runtime:checkUpdates` handler has always produced.
 */
export async function checkRuntimeConfig(): Promise<RemoteConfigCheck<RuntimeConfig>> {
  const url = RUNTIME_CONFIG_URL
  console.log(`[updates] Fetching runtime config from: ${url}`)

  // Detect a corrupt override *before* fetching: loadRuntimeConfig() falls
  // back silently to the bundled config on parse/shape failure, so it alone
  // cannot surface the problem. On corruption nothing is fetched and no
  // files are touched.
  const override = readRuntimeOverride()
  if (override.status === 'corrupt') {
    console.error('[updates] Current runtime config is corrupted')
    throw new Error(
      'Current runtime config is corrupted — click Reset in Settings → Runtime (or restore a .bak) and retry'
    )
  }

  let remoteRaw: string
  try {
    remoteRaw = await fetchText(url)
  } catch (e) {
    console.error('[updates] Runtime config fetch failed:', e)
    throw new Error(`Failed to fetch runtime config from ${url}: ${(e as Error).message}`)
  }

  let remote: RuntimeConfig
  try {
    remote = JSON.parse(remoteRaw) as RuntimeConfig
  } catch (e) {
    console.error('[updates] Remote runtime config is not valid JSON:', e)
    throw new Error(`Remote runtime config is not valid JSON: ${(e as Error).message}`)
  }
  const problem = validateRuntimeConfig(remote)
  if (problem) {
    console.error('[updates] Remote runtime config is invalid:', problem)
    throw new Error(`Remote runtime config is invalid: ${problem}`)
  }
  // Normalize before comparing: a legacy flat remote (no `releases` wrapper)
  // must be shaped like `current` for the key-order-stable compare to be
  // apples-to-apples, and the apply step must save the full authoring shape.
  remote = normalizeRuntimeConfig(remote)

  // The existing override was already validated by readRuntimeOverride()
  // above, so loadRuntimeConfig() *is* the effective config here (valid
  // override, else bundled). Compare key-order-stable.
  const current = loadRuntimeConfig()
  const changed = stableStringify(remote) !== stableStringify(current)
  if (!changed) {
    console.log('[updates] Runtime config is up to date')
  }
  return { changed, remote, current }
}

/**
 * Fetch the remote hub config and compare it against the active one (valid
 * override, else bundled). Detect-only: nothing is written. Throws on a
 * corrupt local override (before fetching — nothing is touched), a fetch
 * failure, or an invalid remote shape, with the same specific messages the
 * `hub:checkUpdates` handler has always produced.
 */
export async function checkHubConfig(): Promise<RemoteConfigCheck<HubConfig>> {
  const url = HUB_CONFIG_URL
  console.log(`[updates] Fetching hub config from: ${url}`)

  // Detect a corrupt override *before* fetching: loadHubConfig() falls back
  // silently to the bundled config on parse/shape failure, so it alone
  // cannot surface the problem. On corruption nothing is fetched and no
  // files are touched.
  const override = readHubOverride()
  if (override.status === 'corrupt') {
    console.error('[updates] Current hub config is corrupted')
    throw new Error(
      'Current hub config is corrupted — click Reset in Settings → Models (or restore a .bak) and retry'
    )
  }

  let remoteRaw: string
  try {
    remoteRaw = await fetchText(url)
  } catch (e) {
    console.error('[updates] Hub config fetch failed:', e)
    throw new Error(`Failed to fetch hub config from ${url}: ${(e as Error).message}`)
  }

  let remote: HubConfig
  try {
    remote = JSON.parse(remoteRaw) as HubConfig
  } catch (e) {
    console.error('[updates] Remote hub config is not valid JSON:', e)
    throw new Error(`Remote hub config is not valid JSON: ${(e as Error).message}`)
  }
  const problem = validateHubConfig(remote)
  if (problem) {
    console.error('[updates] Remote hub config is invalid:', problem)
    throw new Error(`Remote hub config is invalid: ${problem}`)
  }

  // The existing override was already validated by readHubOverride() above,
  // so loadHubConfig() *is* the effective config here (valid override, else
  // bundled). Compare key-order-stable: a key reorder with identical
  // content is NOT an update.
  const current = loadHubConfig()
  const changed = stableStringify(remote) !== stableStringify(current)
  if (!changed) {
    console.log('[updates] Hub config is up to date')
  }
  return { changed, remote, current }
}

/**
 * Result of the most recent completed launch check of this session, or
 * `null` before the first one completes. The renderer pulls it on mount
 * (`updates:get`) to catch up when the check completed before the renderer
 * mounted — the same catch-up pattern as the init pipeline's state.
 */
let lastStatus: ConfigUpdateStatus | null = null

export function getConfigUpdateStatus(): ConfigUpdateStatus | null {
  return lastStatus
}

/**
 * Launch-time update check: fetch the remote hub.json and runtime.json in
 * parallel and compare each against the active config. Detect-only — nothing
 * is written, applying stays a manual Settings → Check action.
 *
 * Failure is silent: a per-config failure (fetch, invalid remote, corrupt
 * override) is logged and treated as "no update" for that config, so an
 * offline or broken launch never nags — the manual `Check` buttons surface
 * specific errors. The whole body is additionally guarded so this function
 * can never reject: the call site is a bare `void checkForConfigUpdates(...)`
 * in `index.ts`, and a rejection would surface as an unhandled promise
 * rejection.
 *
 * `notify` is invoked exactly once with the final status, and only when at
 * least one flag is true — the "only when changed" decision lives here so
 * callers cannot forget it. The caller broadcasts `updates:available`.
 */
export async function checkForConfigUpdates(
  notify: (status: ConfigUpdateStatus) => void
): Promise<ConfigUpdateStatus> {
  try {
    const [runtimeChanged, hubChanged] = await Promise.all([
      checkRuntimeConfig()
        .then((r) => r.changed)
        .catch((e) => {
          console.warn('[updates] Runtime config check failed (treating as no update):', e)
          return false
        }),
      checkHubConfig()
        .then((r) => r.changed)
        .catch((e) => {
          console.warn('[updates] Hub config check failed (treating as no update):', e)
          return false
        })
    ])
    const status: ConfigUpdateStatus = { hub: hubChanged, runtime: runtimeChanged }
    lastStatus = status
    if (status.hub || status.runtime) notify(status)
    return status
  } catch (e) {
    // Belt-and-braces: the per-config catches above already cover the
    // expected failures; this guards an unexpected orchestration error so
    // the `void` call site can never produce an unhandled rejection.
    console.warn('[updates] Launch update check failed unexpectedly:', e)
    const status: ConfigUpdateStatus = { hub: false, runtime: false }
    lastStatus = status
    return status
  }
}
