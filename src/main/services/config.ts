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
  FfmpegConfig,
  HubConfig,
  ResolutionConfig,
  ResolutionEntry,
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
 *   folder's direct files; '/' restricts it to the repo root's direct files);
 *   optional `model_version_ids` (CivitAI version filter — absent or null
 *   means no filter; otherwise a non-empty array of positive integers)
 * - `repo.lora` is optional — absent is valid (older overrides keep working);
 *   present must be an array (empty allowed) of objects with non-empty string
 *   `provider`, `label`, `url` (`https://`) and a non-empty array
 *   `diffustion_types` of non-empty strings (the shipped hub.json's spelling,
 *   kept as-is); optional string `description`; optional non-empty string
 *   `path`; optional `model_version_ids` (same rule as diffusion); optional
 *   string `source` / `domain`
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
    for (const key of ['name', 'label', 'type'] as const) {
      const v = d[key]
      if (typeof v !== 'string' || v === '') {
        return `diffusion_models[${i}].${key} must be a non-empty string`
      }
    }
    // `mode` is legacy-optional: the shipped hub.json no longer carries it,
    // but older overrides still may.
    if (d['mode'] !== undefined && typeof d['mode'] !== 'string') {
      return `diffusion_models[${i}].mode must be a string when present`
    }
    // `access` is optional: 'auth' (token required) or 'gated' (token + ToS
    // acceptance on the model page); null/absent = freely downloadable.
    // Anything else is a typo that would silently no-op the badge — reject it.
    if (
      d['access'] !== undefined &&
      d['access'] !== null &&
      d['access'] !== 'auth' &&
      d['access'] !== 'gated'
    ) {
      return `diffusion_models[${i}].access must be "auth" or "gated" (or null) when present`
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

  // diffusion_inference_types — optional; present-must-be-valid (per-type
  // { text_input: boolean, accepts: string[] | null }).
  const inferenceTypes = obj['diffusion_inference_types']
  if (inferenceTypes !== undefined) {
    if (inferenceTypes === null || typeof inferenceTypes !== 'object' || Array.isArray(inferenceTypes)) {
      return 'hub config "diffusion_inference_types" must be an object when present'
    }
    for (const [key, v] of Object.entries(inferenceTypes as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `diffusion_inference_types["${key}"] must be an object`
      }
      const io = v as Record<string, unknown>
      if (typeof io['text_input'] !== 'boolean') {
        return `diffusion_inference_types["${key}"].text_input must be a boolean`
      }
      if (
        io['accepts'] !== null &&
        io['accepts'] !== undefined &&
        !Array.isArray(io['accepts'])
      ) {
        return `diffusion_inference_types["${key}"].accepts must be an array or null`
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
    // Entry-level `use_as` — the CLI flag for the SINGLE-file (`default`)
    // shape (e.g. `t5xxl` for the wan umt5-xxl encoder). Same flag-safe
    // grammar as `defaults[].use_as`.
    const ua = eo['use_as']
    if (ua !== undefined && (typeof ua !== 'string' || ua === '' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ua))) {
      return `repo.encoder["${key}"].use_as must be a non-empty string matching ^[A-Za-z0-9][A-Za-z0-9_-]*$`
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

  // Optional: absent is valid; present-must-be-valid.
  const tokenizer = repoObj['tokenizer']
  if (tokenizer !== undefined) {
    if (tokenizer === null || typeof tokenizer !== 'object' || Array.isArray(tokenizer)) {
      return 'hub config "repo.tokenizer" must be an object when present'
    }
    for (const [key, t] of Object.entries(tokenizer as Record<string, unknown>)) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) {
        return `repo.tokenizer["${key}"] must be an object`
      }
      const to = t as Record<string, unknown>
      if (
        typeof to['url'] !== 'string' ||
        to['url'] === '' ||
        !to['url'].startsWith('https://')
      ) {
        return `repo.tokenizer["${key}"].url must be a non-empty string starting with https://`
      }
      if (typeof to['default'] !== 'string' || to['default'] === '') {
        return `repo.tokenizer["${key}"].default must be a non-empty string`
      }
      if (to['provider'] !== undefined && typeof to['provider'] !== 'string') {
        return `repo.tokenizer["${key}"].provider must be a string when present`
      }
      if (to['label'] !== undefined && typeof to['label'] !== 'string') {
        return `repo.tokenizer["${key}"].label must be a string when present`
      }
    }
  }

  // Optional: absent is valid; present-must-be-valid (wav2vec2 audio encoder
  // for Wan2.2 S2V — same rules as repo.tokenizer).
  const audioEncoder = repoObj['audio_encoder']
  if (audioEncoder !== undefined) {
    if (audioEncoder === null || typeof audioEncoder !== 'object' || Array.isArray(audioEncoder)) {
      return 'hub config "repo.audio_encoder" must be an object when present'
    }
    for (const [key, v] of Object.entries(audioEncoder as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `repo.audio_encoder["${key}"] must be an object`
      }
      const vo = v as Record<string, unknown>
      if (
        typeof vo['url'] !== 'string' ||
        vo['url'] === '' ||
        !vo['url'].startsWith('https://')
      ) {
        return `repo.audio_encoder["${key}"].url must be a non-empty string starting with https://`
      }
      if (typeof vo['default'] !== 'string' || vo['default'] === '') {
        return `repo.audio_encoder["${key}"].default must be a non-empty string`
      }
      if (vo['provider'] !== undefined && typeof vo['provider'] !== 'string') {
        return `repo.audio_encoder["${key}"].provider must be a string when present`
      }
      if (vo['label'] !== undefined && typeof vo['label'] !== 'string') {
        return `repo.audio_encoder["${key}"].label must be a string when present`
      }
    }
  }

  // Optional: absent is valid; present-must-be-valid (LTX 2.5 audio VAE —
  // same rules as repo.audio_encoder, plus the optional source/domain
  // overrides the other repo sections accept).
  const audioVae = repoObj['audio_vae']
  if (audioVae !== undefined) {
    if (audioVae === null || typeof audioVae !== 'object' || Array.isArray(audioVae)) {
      return 'hub config "repo.audio_vae" must be an object when present'
    }
    for (const [key, v] of Object.entries(audioVae as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `repo.audio_vae["${key}"] must be an object`
      }
      const vo = v as Record<string, unknown>
      if (
        typeof vo['url'] !== 'string' ||
        vo['url'] === '' ||
        !vo['url'].startsWith('https://')
      ) {
        return `repo.audio_vae["${key}"].url must be a non-empty string starting with https://`
      }
      if (typeof vo['default'] !== 'string' || vo['default'] === '') {
        return `repo.audio_vae["${key}"].default must be a non-empty string`
      }
      if (vo['provider'] !== undefined && typeof vo['provider'] !== 'string') {
        return `repo.audio_vae["${key}"].provider must be a string when present`
      }
      if (vo['label'] !== undefined && typeof vo['label'] !== 'string') {
        return `repo.audio_vae["${key}"].label must be a string when present`
      }
      if (vo['source'] !== undefined && typeof vo['source'] !== 'string') {
        return `repo.audio_vae["${key}"].source must be a string when present`
      }
      if (vo['domain'] !== undefined && typeof vo['domain'] !== 'string') {
        return `repo.audio_vae["${key}"].domain must be a string when present`
      }
    }
  }

  // Optional: absent is valid; present-must-be-valid (LTX 2.5 spatial latent
  // upscaler — same rules as repo.audio_encoder, plus the optional
  // source/domain overrides the other repo sections accept).
  const latentUpscaler = repoObj['latent_upscaler']
  if (latentUpscaler !== undefined) {
    if (latentUpscaler === null || typeof latentUpscaler !== 'object' || Array.isArray(latentUpscaler)) {
      return 'hub config "repo.latent_upscaler" must be an object when present'
    }
    for (const [key, v] of Object.entries(latentUpscaler as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `repo.latent_upscaler["${key}"] must be an object`
      }
      const vo = v as Record<string, unknown>
      if (
        typeof vo['url'] !== 'string' ||
        vo['url'] === '' ||
        !vo['url'].startsWith('https://')
      ) {
        return `repo.latent_upscaler["${key}"].url must be a non-empty string starting with https://`
      }
      if (typeof vo['default'] !== 'string' || vo['default'] === '') {
        return `repo.latent_upscaler["${key}"].default must be a non-empty string`
      }
      if (vo['provider'] !== undefined && typeof vo['provider'] !== 'string') {
        return `repo.latent_upscaler["${key}"].provider must be a string when present`
      }
      if (vo['label'] !== undefined && typeof vo['label'] !== 'string') {
        return `repo.latent_upscaler["${key}"].label must be a string when present`
      }
      if (vo['source'] !== undefined && typeof vo['source'] !== 'string') {
        return `repo.latent_upscaler["${key}"].source must be a string when present`
      }
      if (vo['domain'] !== undefined && typeof vo['domain'] !== 'string') {
        return `repo.latent_upscaler["${key}"].domain must be a string when present`
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
    // Optional CivitAI version filter: absent or null = no filter; present =
    // a non-empty array of positive-integer version ids.
    const mvid = dobj['model_version_ids']
    if (mvid !== undefined && mvid !== null) {
      if (!Array.isArray(mvid) || mvid.length === 0) {
        return `repo.diffusion[${i}].model_version_ids must be a non-empty array when present`
      }
      for (let j = 0; j < mvid.length; j++) {
        const v = mvid[j]
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          return `repo.diffusion[${i}].model_version_ids[${j}] must be a positive integer`
        }
      }
    }
    // Optional pagination cap (HuggingFace entries): absent or null = default
    // 1-page scan; present = a positive integer.
    const mp = dobj['max_page']
    if (mp !== undefined && mp !== null) {
      if (typeof mp !== 'number' || !Number.isInteger(mp) || mp <= 0) {
        return `repo.diffusion[${i}].max_page must be a positive integer when present`
      }
    }
    // Optional static multi-file catalog (WAN MoE pairs): one item = one
    // selectable quant = the files of that quant and the CLI slot each is
    // passed under. `use_as` is validated against the CLOSED set of slots
    // buildArgs maps to real flags.
    const cat = dobj['catalog']
    if (cat !== undefined && cat !== null) {
      if (!Array.isArray(cat) || cat.length === 0) {
        return `repo.diffusion[${i}].catalog must be a non-empty array when present`
      }
      for (let j = 0; j < cat.length; j++) {
        const item = cat[j]
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return `repo.diffusion[${i}].catalog[${j}] must be an object`
        }
        const io = item as Record<string, unknown>
        for (const key of ['name', 'label'] as const) {
          const v = io[key]
          if (typeof v !== 'string' || v === '') {
            return `repo.diffusion[${i}].catalog[${j}].${key} must be a non-empty string`
          }
        }
        const items = io['items']
        if (!Array.isArray(items) || items.length === 0) {
          return `repo.diffusion[${i}].catalog[${j}].items must be a non-empty array`
        }
        const seenBase = new Set<string>()
        for (let k = 0; k < items.length; k++) {
          const f = items[k]
          if (f === null || typeof f !== 'object' || Array.isArray(f)) {
            return `repo.diffusion[${i}].catalog[${j}].items[${k}] must be an object`
          }
          const fo = f as Record<string, unknown>
          if (typeof fo['file'] !== 'string' || fo['file'] === '') {
            return `repo.diffusion[${i}].catalog[${j}].items[${k}].file must be a non-empty string`
          }
          const ua = fo['use_as']
          if (
            typeof ua !== 'string' ||
            !(['diffusion-model', 'high_noise_diffusion_model'] as string[]).includes(ua)
          ) {
            return `repo.diffusion[${i}].catalog[${j}].items[${k}].use_as must be "diffusion-model" or "high_noise_diffusion_model"`
          }
          // Duplicate basenames within one item would collide on disk
          // (case-insensitive: Windows FS is case-folded).
          const base = (fo['file'] as string).split('/').pop() ?? ''
          if (base !== '') {
            const low = base.toLowerCase()
            if (seenBase.has(low)) {
              return `repo.diffusion[${i}].catalog[${j}].items[${k}] duplicates basename "${base}"`
            }
            seenBase.add(low)
          }
        }
      }
    }
    // Optional requires block: the diffusion family each companion model
    // resolves from (e.g. wan2_2_t2v requires the wan2_1 VAE + encoder).
    const req = dobj['requires']
    if (req !== undefined && req !== null) {
      if (req === null || typeof req !== 'object' || Array.isArray(req)) {
        return `repo.diffusion[${i}].requires must be an object when present`
      }
      for (const [kind, v] of Object.entries(req as Record<string, unknown>)) {
        if (!['vae', 'encoder', 'audio_encoder'].includes(kind)) {
          return `repo.diffusion[${i}].requires.${kind} is not a known companion kind`
        }
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          return `repo.diffusion[${i}].requires.${kind} must be an object`
        }
        const ro = v as Record<string, unknown>
        if (typeof ro['from'] !== 'string' || ro['from'] === '') {
          return `repo.diffusion[${i}].requires.${kind}.from must be a non-empty string`
        }
      }
    }
  }

  // repo.lora — optional (older overrides without it stay valid); present must
  // be an array (empty allowed) of well-formed LoRA entries. The
  // `diffustion_types` spelling is the shipped hub.json key and is validated
  // as-is (plans/lora-support.md §9).
  const lora = repoObj['lora']
  if (lora !== undefined && lora !== null) {
    if (!Array.isArray(lora)) {
      return 'hub config "repo.lora" must be an array when present'
    }
    for (let i = 0; i < lora.length; i++) {
      const l = lora[i]
      if (l === null || typeof l !== 'object' || Array.isArray(l)) {
        return `repo.lora[${i}] must be an object`
      }
      const lobj = l as Record<string, unknown>
      for (const key of ['provider', 'label'] as const) {
        const v = lobj[key]
        if (typeof v !== 'string' || v === '') {
          return `repo.lora[${i}].${key} must be a non-empty string`
        }
      }
      const lurl = lobj['url']
      if (typeof lurl !== 'string' || lurl === '' || !lurl.startsWith('https://')) {
        return `repo.lora[${i}].url must be a non-empty string starting with https://`
      }
      const dts = lobj['diffustion_types']
      if (!Array.isArray(dts) || dts.length === 0) {
        return `repo.lora[${i}].diffustion_types must be a non-empty array`
      }
      for (let j = 0; j < dts.length; j++) {
        const v = dts[j]
        if (typeof v !== 'string' || v === '') {
          return `repo.lora[${i}].diffustion_types[${j}] must be a non-empty string`
        }
      }
      if (lobj['description'] !== undefined && typeof lobj['description'] !== 'string') {
        return `repo.lora[${i}].description must be a string when present`
      }
      if (lobj['path'] !== undefined) {
        const p = lobj['path']
        if (typeof p !== 'string' || p.trim() === '') {
          return `repo.lora[${i}].path must be a non-empty string when present`
        }
      }
      // Optional CivitAI version filter — same rule as the diffusion branch.
      const mvid = lobj['model_version_ids']
      if (mvid !== undefined && mvid !== null) {
        if (!Array.isArray(mvid) || mvid.length === 0) {
          return `repo.lora[${i}].model_version_ids must be a non-empty array when present`
        }
        for (let j = 0; j < mvid.length; j++) {
          const v = mvid[j]
          if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
            return `repo.lora[${i}].model_version_ids[${j}] must be a positive integer`
          }
        }
      }
      // Optional pagination cap — same rule as the diffusion branch.
      const mp = lobj['max_page']
      if (mp !== undefined && mp !== null) {
        if (typeof mp !== 'number' || !Number.isInteger(mp) || mp <= 0) {
          return `repo.lora[${i}].max_page must be a positive integer when present`
        }
      }
      if (lobj['source'] !== undefined && typeof lobj['source'] !== 'string') {
        return `repo.lora[${i}].source must be a string when present`
      }
      if (lobj['domain'] !== undefined && typeof lobj['domain'] !== 'string') {
        return `repo.lora[${i}].domain must be a string when present`
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

/**
 * Resolution presets per diffusion family. The authoring schema wraps the
 * families under a top-level `presets` object and describes each entry with
 * rich metadata (`label` / `aspect` / `orientation`); the runtime shape stays
 * the flat family → entries record the renderer has always consumed, with
 * `name` derived from `label` when absent so preset matching, the selector
 * dialog, and session persistence keep working unchanged.
 */
export function loadResolutionConfig(): ResolutionConfig {
  const raw = readJson<Record<string, unknown>>(join(getAppRoot(), 'resolution.json'))
  const presets = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw['presets'] : undefined
  const families =
    presets && typeof presets === 'object' && !Array.isArray(presets)
      ? (presets as Record<string, unknown>)
      : raw
  const out: ResolutionConfig = {}
  for (const [family, value] of Object.entries(families)) {
    if (!Array.isArray(value)) continue
    const entries: ResolutionEntry[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const rec = item as Record<string, unknown>
      const width = Number(rec.width)
      const height = Number(rec.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
      const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label : undefined
      const name =
        typeof rec.name === 'string' && rec.name.trim() ? rec.name : (label ?? `${width}×${height}`)
      entries.push({
        name,
        width,
        height,
        ...(label !== undefined ? { label } : {}),
        ...(typeof rec.aspect === 'string' && rec.aspect ? { aspect: rec.aspect } : {}),
        ...(rec.orientation === 'landscape' || rec.orientation === 'portrait' || rec.orientation === 'none'
          ? { orientation: rec.orientation }
          : {})
      })
    }
    out[family] = entries
  }
  return out
}

// ---------- runtime.json override (data/runtime.json) ----------

/**
 * Validate one `releases` version map (version key -> runtime key -> url).
 * Rules:
 * - **non-empty** (an empty `{}` would break `gen:start`'s
 *   `Object.keys(...)[0]` fallback)
 * - every key is a numeric string (`runtime.ts` sorts versions with
 *   `Number(b) - Number(a)`, so a non-numeric key would poison the sort)
 * - every value is a non-empty, non-array object of string → string (url)
 * - every url starts with `https://` (this config drives *binary* download
 *   URLs — a plain `http://` url is a downgrade vector)
 */
function validateRuntimeReleases(releases: Record<string, unknown>): string | undefined {
  const versions = Object.keys(releases)
  if (versions.length === 0) return 'runtime config must not be empty'
  for (const version of versions) {
    if (!/^\d+$/.test(version)) return `version key "${version}" is not numeric`
    const entry = releases[version]
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

/**
 * Validate a parsed runtime config's shape. Returns the first problem found,
 * or `undefined` when the config is valid. Two shapes are accepted:
 *
 * - the authoring shape `{ updatedOn, releases }` — a non-null, **non-array**
 *   object whose `updatedOn` is a non-empty string and whose `releases` is a
 *   valid version map (the bundled `configurations/runtime.json` and every
 *   freshly written override)
 * - the LEGACY flat version map (version keys at the top level) — overrides
 *   written by older builds keep working; `normalizeRuntimeConfig()` wraps
 *   them into the authoring shape at load time
 *
 * Shape detection: presence of either marker key (`updatedOn` / `releases`)
 * selects the authoring shape — a legacy version map can never carry them,
 * because its keys are numeric strings.
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
  if (obj['updatedOn'] !== undefined || obj['releases'] !== undefined) {
    if (typeof obj['updatedOn'] !== 'string' || obj['updatedOn'] === '') {
      return 'runtime config "updatedOn" must be a non-empty string'
    }
    const releases = obj['releases']
    if (releases === null || typeof releases !== 'object' || Array.isArray(releases)) {
      return 'runtime config "releases" must be an object'
    }
    return validateRuntimeReleases(releases as Record<string, unknown>)
  }
  // Legacy flat shape: the top level IS the version map.
  return validateRuntimeReleases(obj)
}

/**
 * Normalize a parsed runtime config into the authoring shape
 * (`{ updatedOn, releases }`): a legacy flat version map is wrapped under
 * `releases` with an empty `updatedOn` marker (unknown for legacy files —
 * the next Check rewrites the override in the full authoring shape). Call
 * AFTER `validateRuntimeConfig()`: the normalized legacy shape would not
 * re-validate (its `updatedOn` is empty by design).
 */
export function normalizeRuntimeConfig(parsed: unknown): RuntimeConfig {
  const obj = (parsed ?? {}) as Record<string, unknown>
  if (obj['updatedOn'] !== undefined || obj['releases'] !== undefined) {
    return parsed as RuntimeConfig
  }
  return { updatedOn: '', releases: obj as RuntimeConfig['releases'] }
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
 * - otherwise → `ok`, normalized into the authoring shape (a legacy flat
 *   override is wrapped under `releases`)
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
  return { status: 'ok', cfg: normalizeRuntimeConfig(parsed) }
}

/**
 * The active runtime config: the writable override at `data/runtime.json`
 * when it exists and is valid, otherwise the bundled
 * `configurations/runtime.json`. A corrupt override (torn write or bad
 * shape) is non-fatal: it logs a warning and falls back to the bundled
 * config, so `runtime:versions`, `downloads:list`, `gen:start`, and the
 * init pipeline all keep working. The warning fires on every call while the
 * corrupt file sits on disk — expected, not a bug. The returned config is
 * always the authoring shape (`{ updatedOn, releases }`): a legacy flat
 * source (old override or old bundled file) is normalized on the way out.
 */
export function loadRuntimeConfig(): RuntimeConfig {
  const read = readRuntimeOverride()
  if (read.status === 'ok') return read.cfg
  if (read.status === 'corrupt') {
    console.warn(
      `[config] runtime.json override corrupted (${read.reason}); using the bundled config`
    )
  }
  return normalizeRuntimeConfig(readJson<unknown>(join(getAppRoot(), 'runtime.json')))
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

/**
 * The bundled `configurations/ffmpeg.json`: per-platform download URLs for
 * static ffmpeg builds. Bundled file only — no override / Check / Reset UI
 * for v1 (the runtime/hub override machinery can be added later if the
 * third-party mirror URLs drift). Throws when missing — same loud-failure
 * contract as `loadApplicationConfig()` for a file that must always exist
 * in the bundle.
 */
export function loadFfmpegConfig(): FfmpegConfig {
  return readJson<FfmpegConfig>(join(getAppRoot(), 'ffmpeg.json'))
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
