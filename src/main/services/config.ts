/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AllConfigs,
  ApplicationConfig,
  HubConfig,
  ResolutionConfig,
  RuntimeConfig,
  SamplingConfig
} from '@shared/types'
import { dataRoot } from './data'

/**
 * The `configurations/` folder itself.
 * Dev: `<project root>/configurations`. Packaged: `resources/configurations`
 * (via electron-builder extraResources).
 */
export function getAppRoot(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'configurations'), join(process.resourcesPath)]
    : [join(app.getAppPath(), 'configurations'), app.getAppPath()]
  for (const c of candidates) {
    if (existsSync(join(c, 'hub.json'))) return c
  }
  return candidates[0]
}

function readJson<T>(file: string): T {
  const raw = readFileSync(file, 'utf-8')
  return JSON.parse(raw) as T
}

/**
 * App identity from the bundled `configurations/application.json`. App
 * identity ships with the app: no override, no remote check. Throws when
 * missing — same loud-failure contract as `loadHubConfig()` for a file that
 * must always exist in the bundle.
 */
export function loadApplicationConfig(): ApplicationConfig {
  return readJson<ApplicationConfig>(join(getAppRoot(), 'application.json'))
}

// ---------- hub.json override (data/hub.json) ----------

/**
 * Validate a parsed hub config's shape. Returns the first problem found,
 * or `undefined` when the config is valid. Rules:
 * - non-null, **non-array** object (explicit `Array.isArray` check —
 *   `typeof [] === 'object'`, same rationale as the runtime validator)
 * - `updatedOn` is a non-empty string
 * - `diffusion_models` is a **non-empty** array; every entry is an object
 *   with non-empty string `name`, `label`, `type`, `mode`
 * - `providers` is an array (empty allowed — it only drives label
 *   resolution); every entry is an object with non-empty string
 *   `name` and `label`
 * - `repo` is an object containing `vae`, `encoder` (objects; empty records
 *   allowed) and `diffusion` (a **non-empty** array); `vision` is optional —
 *   absent is valid (no diffusion type currently needs a vision model
 *   upstream), present-must-be-valid (an object; empty records allowed)
 * - `repo.vae` values: either a string (legacy plain-URL form — must start
 *   with `https://`) or an object with non-empty string `url` (must start
 *   with `https://`) and non-empty string `default`; optional string
 *   `provider`
 * - `repo.encoder` values: objects with non-empty string `url` (`https://`)
 *   and **either** a non-empty string `default` (single-file encoder) **or**
 *   a non-empty `defaults` array of `{ file, use_as }` objects (multi-file
 *   encoder bundle). Each `defaults[]` item needs non-empty string `file`
 *   and `use_as` matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` (no leading dash —
 *   it is interpolated into a `--<use_as>` CLI flag); duplicate `use_as`
 *   values and duplicate file basenames within one array are rejected (both
 *   would collide at spawn / on disk). Optional string `provider` / `label`
 * - `repo.vision` values: objects with non-empty string `url` (`https://`)
 *   and non-empty string `default`; optional string `provider` / `label`
 * - `repo.diffusion` entries: objects with non-empty string `provider`,
 *   `name`, `label`, `inference_type`, `quant_type`, `diffusion_type`,
 *   `url` (`https://`); optional string `description`; optional non-empty
 *   string `path` (repo-relative folder restricting the hub scan to that
 *   folder's direct files; '/' restricts it to the repo root's direct files)
 * - `default` is a repo-relative path *or* full URL in practice — only a
 *   non-empty string is required, never an `https://` prefix
 *
 * Deliberately lenient on unknown keys (same philosophy as
 * `validateRuntimeConfig`): a typo'd upstream key is ignored by consumers
 * rather than blocking every update.
 */
export function validateHubConfig(cfg: unknown): string | undefined {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return 'hub config must be a JSON object'
  }
  const obj = cfg as Record<string, unknown>

  if (typeof obj['updatedOn'] !== 'string' || obj['updatedOn'] === '') {
    return 'hub config "updatedOn" must be a non-empty string'
  }

  const dms = obj['diffusion_models']
  if (!Array.isArray(dms) || dms.length === 0) {
    return 'hub config "diffusion_models" must be a non-empty array'
  }
  for (let i = 0; i < dms.length; i++) {
    const dm = dms[i]
    if (dm === null || typeof dm !== 'object' || Array.isArray(dm)) {
      return `diffusion_models[${i}] must be an object`
    }
    const d = dm as Record<string, unknown>
    for (const key of ['name', 'label', 'type', 'mode'] as const) {
      const v = d[key]
      if (typeof v !== 'string' || v === '') {
        return `diffusion_models[${i}].${key} must be a non-empty string`
      }
    }
  }

  const providers = obj['providers']
  if (!Array.isArray(providers)) {
    return 'hub config "providers" must be an array'
  }
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      return `providers[${i}] must be an object`
    }
    const po = p as Record<string, unknown>
    for (const key of ['name', 'label'] as const) {
      const v = po[key]
      if (typeof v !== 'string' || v === '') {
        return `providers[${i}].${key} must be a non-empty string`
      }
    }
  }

  const repo = obj['repo']
  if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) {
    return 'hub config "repo" must be an object'
  }
  const repoObj = repo as Record<string, unknown>

  const vae = repoObj['vae']
  if (vae === null || typeof vae !== 'object' || Array.isArray(vae)) {
    return 'hub config "repo.vae" must be an object'
  }
  for (const [key, v] of Object.entries(vae as Record<string, unknown>)) {
    // Legacy plain-URL form (the `HubVaeEntry | string` union arm).
    if (typeof v === 'string') {
      if (!v.startsWith('https://')) {
        return `repo.vae["${key}"] url must start with https://`
      }
      continue
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return `repo.vae["${key}"] must be a url string or an object`
    }
    const vo = v as Record<string, unknown>
    if (
      typeof vo['url'] !== 'string' ||
      vo['url'] === '' ||
      !vo['url'].startsWith('https://')
    ) {
      return `repo.vae["${key}"].url must be a non-empty string starting with https://`
    }
    if (typeof vo['default'] !== 'string' || vo['default'] === '') {
      return `repo.vae["${key}"].default must be a non-empty string`
    }
    if (vo['provider'] !== undefined && typeof vo['provider'] !== 'string') {
      return `repo.vae["${key}"].provider must be a string when present`
    }
  }

  const encoder = repoObj['encoder']
  if (encoder === null || typeof encoder !== 'object' || Array.isArray(encoder)) {
    return 'hub config "repo.encoder" must be an object'
  }
  for (const [key, v] of Object.entries(encoder as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return `repo.encoder["${key}"] must be an object`
    }
    const eo = v as Record<string, unknown>
    if (
      typeof eo['url'] !== 'string' ||
      eo['url'] === '' ||
      !eo['url'].startsWith('https://')
    ) {
      return `repo.encoder["${key}"].url must be a non-empty string starting with https://`
    }
    // Single-file (`default`) or bundle (`defaults`) — exactly one of the two
    // shapes is required; both may coexist (the catalog then emits entries for
    // both), but neither may be malformed.
    const defaultOk = typeof eo['default'] === 'string' && eo['default'] !== ''
    const defaultsRaw: unknown = eo['defaults']
    const defaultsOk = Array.isArray(defaultsRaw) && defaultsRaw.length > 0
    if (!defaultOk && !defaultsOk) {
      return `repo.encoder["${key}"] must carry a non-empty "default" string or a non-empty "defaults" array`
    }
    // Validate the bundle whenever the key is present — even alongside a
    // valid `default` — so a malformed bundle is never silently half-consumed.
    if (defaultsRaw !== undefined) {
      if (!defaultsOk) {
        return `repo.encoder["${key}"].defaults must be a non-empty array when present`
      }
      const seenUseAs = new Set<string>()
      const seenBase = new Set<string>()
      for (let j = 0; j < (defaultsRaw as unknown[]).length; j++) {
        const item = (defaultsRaw as unknown[])[j]
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return `repo.encoder["${key}"].defaults[${j}] must be an object`
        }
        const io = item as Record<string, unknown>
        if (typeof io['file'] !== 'string' || io['file'] === '') {
          return `repo.encoder["${key}"].defaults[${j}].file must be a non-empty string`
        }
        const ua = io['use_as']
        if (typeof ua !== 'string' || ua === '' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ua)) {
          return `repo.encoder["${key}"].defaults[${j}].use_as must be a non-empty string matching ^[A-Za-z0-9][A-Za-z0-9_-]*$`
        }
        if (seenUseAs.has(ua)) {
          return `repo.encoder["${key}"].defaults[${j}].use_as "${ua}" is duplicated`
        }
        seenUseAs.add(ua)
        // Duplicate basenames would collide in both the catalog id
        // (`encoder:<dt>:<basename>`) and the on-disk file name (`downloadModel`
        // derives it from the URL basename), so the second file could never be
        // resolved by `pathFor()`. Case-insensitive: Windows FS is case-folded.
        const base = (io['file'] as string).split('/').pop() ?? ''
        if (base !== '') {
          const low = base.toLowerCase()
          if (seenBase.has(low)) {
            return `repo.encoder["${key}"].defaults[${j}] duplicates basename "${base}"`
          }
          seenBase.add(low)
        }
      }
    }
    if (eo['provider'] !== undefined && typeof eo['provider'] !== 'string') {
      return `repo.encoder["${key}"].provider must be a string when present`
    }
    if (eo['label'] !== undefined && typeof eo['label'] !== 'string') {
      return `repo.encoder["${key}"].label must be a string when present`
    }
  }

  // Optional: absent is valid; present-must-be-valid.
  const vision = repoObj['vision']
  if (vision !== undefined) {
    if (vision === null || typeof vision !== 'object' || Array.isArray(vision)) {
      return 'hub config "repo.vision" must be an object when present'
    }
    for (const [key, v] of Object.entries(vision as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `repo.vision["${key}"] must be an object`
      }
      const vo = v as Record<string, unknown>
      if (
        typeof vo['url'] !== 'string' ||
        vo['url'] === '' ||
        !vo['url'].startsWith('https://')
      ) {
        return `repo.vision["${key}"].url must be a non-empty string starting with https://`
      }
      if (typeof vo['default'] !== 'string' || vo['default'] === '') {
        return `repo.vision["${key}"].default must be a non-empty string`
      }
      if (vo['provider'] !== undefined && typeof vo['provider'] !== 'string') {
        return `repo.vision["${key}"].provider must be a string when present`
      }
      if (vo['label'] !== undefined && typeof vo['label'] !== 'string') {
        return `repo.vision["${key}"].label must be a string when present`
      }
    }
  }

  const diffusion = repoObj['diffusion']
  if (!Array.isArray(diffusion) || diffusion.length === 0) {
    return 'hub config "repo.diffusion" must be a non-empty array'
  }
  for (let i = 0; i < diffusion.length; i++) {
    const d = diffusion[i]
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      return `repo.diffusion[${i}] must be an object`
    }
    const dobj = d as Record<string, unknown>
    for (const key of [
      'provider',
      'name',
      'label',
      'inference_type',
      'quant_type',
      'diffusion_type'
    ] as const) {
      const v = dobj[key]
      if (typeof v !== 'string' || v === '') {
        return `repo.diffusion[${i}].${key} must be a non-empty string`
      }
    }
    const url = dobj['url']
    if (typeof url !== 'string' || url === '' || !url.startsWith('https://')) {
      return `repo.diffusion[${i}].url must be a non-empty string starting with https://`
    }
    if (dobj['description'] !== undefined && typeof dobj['description'] !== 'string') {
      return `repo.diffusion[${i}].description must be a string when present`
    }
    if (dobj['path'] !== undefined) {
      const p = dobj['path']
      if (typeof p !== 'string' || p.trim() === '') {
        return `repo.diffusion[${i}].path must be a non-empty string when present`
      }
    }
  }

  return undefined
}

/** Absolute path of the writable hub config override. */
function hubOverridePath(): string {
  return join(dataRoot(), 'hub.json')
}

export type HubOverrideRead =
  | { status: 'absent' }
  | { status: 'ok'; cfg: HubConfig }
  | { status: 'corrupt'; reason: string }

/**
 * Read + parse + shape-validate the hub config override in one place, so
 * `loadHubConfig()` and the update-check handler can never diverge:
 * - no file → `absent`
 * - parse or shape failure → `corrupt` (with the reason)
 * - otherwise → `ok`
 */
export function readHubOverride(): HubOverrideRead {
  const p = hubOverridePath()
  if (!existsSync(p)) return { status: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    return { status: 'corrupt', reason: (e as Error).message }
  }
  const problem = validateHubConfig(parsed)
  if (problem) return { status: 'corrupt', reason: problem }
  return { status: 'ok', cfg: parsed as HubConfig }
}

/**
 * The active hub config: the writable override at `data/hub.json` when it
 * exists and is valid, otherwise the bundled `configurations/hub.json`. A
 * corrupt override (torn write or bad shape) is non-fatal: it logs a
 * warning and falls back to the bundled config, so `app:configs`, the
 * catalog build, `gen:start`, and the init pipeline all keep working. The
 * warning fires on every call while the corrupt file sits on disk —
 * expected, mirrors `loadRuntimeConfig()`.
 */
export function loadHubConfig(): HubConfig {
  const read = readHubOverride()
  if (read.status === 'ok') return read.cfg
  if (read.status === 'corrupt') {
    console.warn(
      `[config] hub.json override corrupted (${read.reason}); using the bundled config`
    )
  }
  return readJson<HubConfig>(join(getAppRoot(), 'hub.json'))
}

/**
 * Write `cfg` to the override path `data/hub.json` — **always** the
 * override path (the same constant `hubOverridePath()` resolves), never the
 * bundled file, which is read-only in packaged builds. Before overwriting an
 * existing override, the old file is copied to a timestamped
 * `hub.json.<YYYYMMDD-HHMMSS>.bak` backup (local time; `-1`, `-2`, …
 * inserted before the `.bak` extension on same-second collisions; backups
 * accumulate, no pruning). The write itself is atomic: temp file + explicit
 * remove + rename (Windows `renameSync` does not overwrite an existing
 * destination), so `data/hub.json` never holds partial content.
 */
export function saveHubConfig(cfg: HubConfig): void {
  const p = hubOverridePath()
  if (existsSync(p)) {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    let bak = `${p}.${stamp}.bak`
    for (let i = 1; existsSync(bak); i++) {
      bak = `${p}.${stamp}-${i}.bak`
    }
    copyFileSync(p, bak)
  }
  const tmp = p + '.tmp'
  mkdirSync(dirname(p), { recursive: true })
  // Hygiene: clear a leftover temp file from a crash mid-write (it is never read).
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  // The old override is already backed up, so it can be removed outright;
  // Windows renameSync does not overwrite an existing destination.
  rmSync(p, { force: true })
  renameSync(tmp, p)
}

/**
 * Delete the hub config override so the bundled `configurations/hub.json`
 * becomes active again. No-op when no override exists. Never touches the
 * `.bak` backups (they remain the manual recovery path).
 */
export function resetHubConfig(): void {
  const p = hubOverridePath()
  if (existsSync(p)) rmSync(p, { force: true })
}

export function loadSamplingConfig(): SamplingConfig {
  return readJson<SamplingConfig>(join(getAppRoot(), 'sampling.json'))
}

export function loadResolutionConfig(): ResolutionConfig {
  return readJson<ResolutionConfig>(join(getAppRoot(), 'resolution.json'))
}

// ---------- runtime.json override (data/runtime.json) ----------

/**
 * Validate a parsed runtime config's shape. Returns the first problem found,
 * or `undefined` when the config is valid. Rules:
 * - non-null, **non-array** object (explicit `Array.isArray` check —
 *   `typeof [] === 'object'` and `Object.keys([])` yields numeric strings,
 *   so a top-level array would otherwise pass every other rule and surface
 *   in the versions list as `v0`, `v1`, …)
 * - **non-empty** (an empty `{}` would break `gen:start`'s
 *   `Object.keys(...)[0]` fallback)
 * - every top-level key is a numeric string (`runtime.ts` sorts versions
 *   with `Number(b) - Number(a)`, so a non-numeric key would poison the sort)
 * - every value is a non-empty, non-array object of string → string (url)
 * - every url starts with `https://` (the bundled config is all-https and
 *   this config drives *binary* download URLs — a plain `http://` url is a
 *   downgrade vector)
 *
 * Deliberately lenient on per-version keys: unknown keys are safe to ignore
 * (`requiredUrls()` filters against the known `RuntimeKey` list), so a typo'd
 * key in an upstream config is simply never used.
 */
export function validateRuntimeConfig(cfg: unknown): string | undefined {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return 'runtime config must be a JSON object'
  }
  const obj = cfg as Record<string, unknown>
  const versions = Object.keys(obj)
  if (versions.length === 0) return 'runtime config must not be empty'
  for (const version of versions) {
    if (!/^\d+$/.test(version)) return `version key "${version}" is not numeric`
    const entry = obj[version]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `version ${version} must be an object`
    }
    const entryObj = entry as Record<string, unknown>
    const keys = Object.keys(entryObj)
    if (keys.length === 0) return `version ${version} must not be empty`
    for (const key of keys) {
      const url = entryObj[key]
      if (typeof url !== 'string') {
        return `version ${version} key "${key}" must map to a url string`
      }
      if (!url.startsWith('https://')) {
        return `version ${version} key "${key}" url must start with https://`
      }
    }
  }
  return undefined
}

/** Absolute path of the writable runtime config override. */
function overridePath(): string {
  return join(dataRoot(), 'runtime.json')
}

export type RuntimeOverrideRead =
  | { status: 'absent' }
  | { status: 'ok'; cfg: RuntimeConfig }
  | { status: 'corrupt'; reason: string }

/**
 * Read + parse + shape-validate the runtime config override in one place, so
 * `loadRuntimeConfig()` and the update-check handler can never diverge:
 * - no file → `absent`
 * - parse or shape failure → `corrupt` (with the reason)
 * - otherwise → `ok`
 */
export function readRuntimeOverride(): RuntimeOverrideRead {
  const p = overridePath()
  if (!existsSync(p)) return { status: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    return { status: 'corrupt', reason: (e as Error).message }
  }
  const problem = validateRuntimeConfig(parsed)
  if (problem) return { status: 'corrupt', reason: problem }
  return { status: 'ok', cfg: parsed as RuntimeConfig }
}

/**
 * The active runtime config: the writable override at `data/runtime.json`
 * when it exists and is valid, otherwise the bundled
 * `configurations/runtime.json`. A corrupt override (torn write or bad
 * shape) is non-fatal: it logs a warning and falls back to the bundled
 * config, so `runtime:versions`, `downloads:list`, `gen:start`, and the
 * init pipeline all keep working. The warning fires on every call while the
 * corrupt file sits on disk — expected, not a bug.
 */
export function loadRuntimeConfig(): RuntimeConfig {
  const read = readRuntimeOverride()
  if (read.status === 'ok') return read.cfg
  if (read.status === 'corrupt') {
    console.warn(
      `[config] runtime.json override corrupted (${read.reason}); using the bundled config`
    )
  }
  return readJson<RuntimeConfig>(join(getAppRoot(), 'runtime.json'))
}

/**
 * Write `cfg` to the override path `data/runtime.json` — **always** the
 * override path (the same constant `overridePath()` resolves), never the
 * bundled file, which is read-only in packaged builds. Before overwriting an
 * existing override, the old file is copied to a timestamped
 * `runtime.json.<YYYYMMDD-HHMMSS>.bak` backup (local time; `-1`, `-2`, …
 * inserted before the `.bak` extension on same-second collisions; backups
 * accumulate, no pruning). The write itself is atomic: temp file + explicit
 * remove + rename (Windows `renameSync` does not overwrite an existing
 * destination), so `data/runtime.json` never holds partial content.
 */
export function saveRuntimeConfig(cfg: RuntimeConfig): void {
  const p = overridePath()
  if (existsSync(p)) {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    let bak = `${p}.${stamp}.bak`
    for (let i = 1; existsSync(bak); i++) {
      bak = `${p}.${stamp}-${i}.bak`
    }
    copyFileSync(p, bak)
  }
  const tmp = p + '.tmp'
  mkdirSync(dirname(p), { recursive: true })
  // Hygiene: clear a leftover temp file from a crash mid-write (it is never read).
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  // The old override is already backed up, so it can be removed outright;
  // Windows renameSync does not overwrite an existing destination.
  rmSync(p, { force: true })
  renameSync(tmp, p)
}

/**
 * Delete the runtime config override so the bundled
 * `configurations/runtime.json` becomes active again. No-op when no
 * override exists. Never touches the `.bak` backups (they remain the manual
 * recovery path).
 */
export function resetRuntimeConfig(): void {
  const p = overridePath()
  if (existsSync(p)) rmSync(p, { force: true })
}

export function loadAllConfigs(): AllConfigs {
  return {
    hub: loadHubConfig(),
    sampling: loadSamplingConfig(),
    resolution: loadResolutionConfig(),
    runtime: loadRuntimeConfig(),
    application: loadApplicationConfig()
  }
}
