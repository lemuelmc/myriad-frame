/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEDULER_MODEL_DEFAULT, isValidSeed } from '@shared/types'
import type { AdetailerSettings, ChatMessage, LoraApplyMode, Session, SessionControlNet, SessionInputs, SessionIpAdapter, SessionLora } from '@shared/types'
import { dataRoot } from './data'

function sessionsRoot(): string {
  return join(dataRoot(), 'sessions')
}

function sessionPath(id: string): string {
  return join(sessionsRoot(), `${id}.json`)
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export interface SessionsService {
  list: () => Session[]
  get: (id: string) => Session | null
  create: (name?: string) => Session
  rename: (id: string, name: string) => Session
  remove: (id: string) => void
  addMessage: (id: string, msg: ChatMessage) => Session
  updateMessage: (id: string, messageId: string, patch: Partial<ChatMessage>) => Session
  removeMessage: (id: string, messageId: string) => Session
  setInputs: (id: string, patch: SessionInputs) => Session
}

export function createSessionsService(): SessionsService {
  mkdirSync(sessionsRoot(), { recursive: true })

  function read(id: string): Session | null {
    const p = sessionPath(id)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as Session
    } catch {
      return null
    }
  }

  function write(s: Session): void {
    s.updatedAt = Date.now()
    writeFileSync(sessionPath(s.id), JSON.stringify(s, null, 2))
  }

  function list(): Session[] {
    return readdirSync(sessionsRoot())
      .filter((f) => f.endsWith('.json'))
      .map((f) => read(f.replace(/\.json$/, '')))
      .filter((s): s is Session => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function create(name?: string): Session {
    const s: Session = {
      id: newId(),
      name: name?.trim() || `Session ${list().length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
    write(s)
    return s
  }

  function rename(id: string, name: string): Session {
    const s = read(id)
    if (!s) throw new Error(`Session ${id} not found`)
    s.name = name.trim() || s.name
    write(s)
    return s
  }

  function remove(id: string): void {
    const p = sessionPath(id)
    if (existsSync(p)) rmSync(p, { force: true })
  }

  function addMessage(id: string, msg: ChatMessage): Session {
    const s = read(id)
    if (!s) throw new Error(`Session ${id} not found`)
    s.messages.push(msg)
    write(s)
    return s
  }

  function updateMessage(id: string, messageId: string, patch: Partial<ChatMessage>): Session {
    const s = read(id)
    if (!s) throw new Error(`Session ${id} not found`)
    const msg = s.messages.find((m) => m.id === messageId)
    if (!msg) throw new Error(`Message ${messageId} not found`)
    Object.assign(msg, patch)
    write(s)
    return s
  }

  function removeMessage(id: string, messageId: string): Session {
    const s = read(id)
    if (!s) throw new Error(`Session ${id} not found`)
    const i = s.messages.findIndex((m) => m.id === messageId)
    if (i < 0) throw new Error(`Message ${messageId} not found`)
    const [removed] = s.messages.splice(i, 1)
    // Clean up the generated image file if this message had one.
    if (removed.image && existsSync(removed.image.path)) {
      rmSync(removed.image.path, { force: true })
    }
    write(s)
    return s
  }

  /**
   * Shallow-merge a composer-input patch onto the session's saved `inputs`
   * and persist. Defensive filtering keeps a stray renderer payload from
   * shaping the persisted file: only the known keys merge, and each key's
   * value must validate — a key that fails (including an explicit `null`) is
   * dropped instead of merged, so a bogus payload can never overwrite a
   * previously saved value. Merging onto the existing `inputs ?? {}` (never a
   * blank object) means a partial patch cannot erase previously saved keys.
   */
  function setInputs(id: string, patch: SessionInputs): Session {
    const s = read(id)
    if (!s) throw new Error(`Session ${id} not found`)
    const merged: SessionInputs = { ...(s.inputs ?? {}) }
    if (typeof patch.model === 'string' && patch.model !== '') merged.model = patch.model
    // family: the NEW name for diffusionType (same value). New sessions
    // persist `family` instead; when a valid family merges in the legacy
    // `diffusionType` key is dropped, so a re-picked model migrates the saved
    // file to the new shape. A patch WITHOUT family (legacy renderer) still
    // merges diffusionType for old-session compatibility.
    if (typeof patch.family === 'string' && patch.family !== '') {
      merged.family = patch.family
      delete merged.diffusionType
    } else if (typeof patch.diffusionType === 'string' && patch.diffusionType !== '') {
      merged.diffusionType = patch.diffusionType
    }
    // modelProvider: pins the diffusion VARIANT across session reloads
    // (model-collision-hardening plan §4/§6) — with duplicate basenames
    // within a family, name+diffusionType alone could silently switch
    // variants. Absent (legacy sessions) → restore falls back to the first
    // name match.
    if (typeof patch.modelProvider === 'string' && patch.modelProvider !== '')
      merged.modelProvider = patch.modelProvider
    // diffusionName: the hub.json diffusion entry `name` for the saved model
    // (e.g. comfy_org_boogu_image) — lets the entry's hub configuration (its
    // `requires` block…) be looked up precisely when a family maps to several
    // entries. Absent (legacy sessions / a pre-hubName catalog cache) → the
    // family match remains the lookup.
    if (typeof patch.diffusionName === 'string' && patch.diffusionName !== '')
      merged.diffusionName = patch.diffusionName
    if (
      patch.resolution !== null &&
      typeof patch.resolution === 'object' &&
      typeof patch.resolution.name === 'string' &&
      Number.isFinite(patch.resolution.width) &&
      Number.isFinite(patch.resolution.height)
    ) {
      merged.resolution = {
        name: patch.resolution.name,
        width: patch.resolution.width,
        height: patch.resolution.height
      }
    }
    // negativePrompt: string → trimmed; empty string CLEARS the saved value.
    if (typeof patch.negativePrompt === 'string') {
      const t = patch.negativePrompt.trim()
      if (t) merged.negativePrompt = t
      else delete merged.negativePrompt
    }
    // sampling: null CLEARS the saved override (the dialog Reset button's
    // explicit clear signal — different from the `resolution: null` = ignore
    // semantics); object → whitelist the 6 keys with per-key validation.
    // Width/height are no longer session-overridable.
    if (patch.sampling === null) {
      delete merged.sampling
    } else if (patch.sampling && typeof patch.sampling === 'object') {
      const dst = { ...(merged.sampling ?? {}) }
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      // Materialized-snapshot semantics: the dialog saves the FULL effective
      // set (sampling.json defaults ⊕ settings overrides ⊕ user edits), so a
      // PRESENT key always stores — a valid value as-is, null / '' / invalid
      // as null ("auto": the CLI honors only non-empty, non-null settings
      // and omits the flag). An ABSENT key keeps the previous value so
      // partial patches (e.g. the mask-save strength bump) still merge.
      const n = num(patch.sampling.steps)
      if (n !== undefined && n > 0) dst.steps = n
      else if (patch.sampling.steps !== undefined) dst.steps = null
      const c = num(patch.sampling.cfg)
      if (c !== undefined) dst.cfg = c
      else if (patch.sampling.cfg !== undefined) dst.cfg = null
      const s = num(patch.sampling.strength)
      if (s !== undefined) dst.strength = s
      else if (patch.sampling.strength !== undefined) dst.strength = null
      const sm = str(patch.sampling.sampler)
      if (sm) dst.sampler = sm
      else if (patch.sampling.sampler !== undefined) dst.sampler = null
      const sc = patch.sampling.scheduler
      // Normalize "no scheduler" to the sentinel — stored value is always a
      // string, so downstream checks never need a null branch.
      if (sc === null) dst.scheduler = SCHEDULER_MODEL_DEFAULT
      else {
        const v = str(sc)
        if (v) dst.scheduler = v
      }
      const fs = patch.sampling.flow_shift
      // Flow shift: '' / null store an explicit "none" (overwrites a previous
      // number); a finite number (incl 0) stores as-is; a numeric string is
      // normalized to a number; undefined drops the key (inherit).
      if (fs === null || (typeof fs === 'string' && !fs.trim())) dst.flow_shift = ''
      else if (typeof fs === 'number' && Number.isFinite(fs)) dst.flow_shift = fs
      else if (typeof fs === 'string' && Number.isFinite(Number(fs.trim()))) dst.flow_shift = Number(fs.trim())
      // Video-era / high-noise fields: the same materialized semantics — a
      // present key stores a valid value or null ("auto"); absent keeps.
      const hs = num(patch.sampling.high_steps)
      if (hs !== undefined && hs > 0) dst.high_steps = hs
      else if (patch.sampling.high_steps !== undefined) dst.high_steps = null
      const hc = num(patch.sampling.high_cfg)
      if (hc !== undefined && hc >= 0) dst.high_cfg = hc
      else if (patch.sampling.high_cfg !== undefined) dst.high_cfg = null
      const hsam = str(patch.sampling.high_sampler)
      if (hsam) dst.high_sampler = hsam
      else if (patch.sampling.high_sampler !== undefined) dst.high_sampler = null
      const fr = num(patch.sampling.frames)
      if (fr !== undefined && fr > 0) dst.frames = fr
      else if (patch.sampling.frames !== undefined) dst.frames = null
      const fps = num(patch.sampling.frame_rate)
      if (fps !== undefined && fps > 0) dst.frame_rate = fps
      else if (patch.sampling.frame_rate !== undefined) dst.frame_rate = null
      const sd = patch.sampling.seed
      // Seed: a finite integer in [0, SEED_MAX] stores as a fixed seed
      // (floored); null / undefined / anything else drops the key — absent =
      // random every run. Strict: invalid values are deleted, never clamped
      // (the dialog-side clamp is UX friendliness only).
      if (isValidSeed(sd)) dst.seed = Math.floor(sd)
      else delete dst.seed
      // Checkbox normalization (defensive — the payload crosses IPC as
      // untyped JSON): a PRESENT value always stores a definite boolean
      // ('checked'/'true' → true, everything else → false); absent deletes
      // the key (inherit).
      const up = patch.sampling.upscale as unknown
      if (up === undefined) delete dst.upscale
      else dst.upscale = up === true || up === 'checked' || up === 'true'
      // Number-or-null semantics: a finite number ≥ 0 stores as-is (0 ≡
      // "reuse --steps"); null / '' (empty string ≡ null) / any other
      // non-number stores null (⇒ --hires-steps omitted); absent deletes the
      // key (inherit). The dialog sends the full draft on every save, so a
      // saved session pins the draft's values (clear the input ⇒ null ⇒ no
      // --hires-steps; Reset clears the whole override).
      const usRaw = patch.sampling.upscaler_steps as unknown
      if (usRaw === undefined) delete dst.upscaler_steps
      else if (typeof usRaw === 'number' && Number.isFinite(usRaw) && usRaw >= 0) dst.upscaler_steps = usRaw
      else dst.upscaler_steps = null
      // Model args: a non-empty trimmed string stores as-is; '' / null →
      // explicit "none" (overwrites a prior value); undefined drops the key
      // (inherit). The dialog sends the full draft on every save, so a saved
      // session pins the draft's value (clear the input ⇒ null ⇒ no
      // --model-args; Reset clears the whole override).
      const maRaw = patch.sampling.modelArgs as unknown
      if (maRaw === undefined) delete dst.modelArgs
      else if (typeof maRaw === 'string' && maRaw.trim() !== '') dst.modelArgs = maRaw.trim()
      else dst.modelArgs = null
      // Universal args: a non-empty trimmed string stores as-is; '' / null →
      // explicit "none" (overwrites a prior value); undefined drops the key
      // (inherit). Same materialized-snapshot semantics as modelArgs.
      const argsRaw = patch.sampling.args as unknown
      if (argsRaw === undefined) delete dst.args
      else if (typeof argsRaw === 'string' && argsRaw.trim() !== '') dst.args = argsRaw.trim()
      else dst.args = null
      if (Object.keys(dst).length) merged.sampling = dst
    }
    // lora: null CLEARS the saved config (the dialog Reset button's explicit
    // clear signal); object → validate. The mode must be one of the four
    // LoraApplyMode literals and the dir (when present) a non-empty string —
    // anything else drops the whole patch so a bogus renderer payload can
    // never poison the session file (same defensive philosophy as `sampling`).
    // Note the branch REPLACES merged.lora wholesale (never merges onto the
    // old object) so clearing `dir` is a plain `{ mode }` save.
    if (patch.lora === null) {
      delete merged.lora
    } else if (patch.lora && typeof patch.lora === 'object') {
      const m = patch.lora.mode
      const modes: LoraApplyMode[] = ['off', 'auto', 'immediately', 'at_runtime']
      if (modes.includes(m)) {
        const dst: SessionLora = { mode: m }
        if (typeof patch.lora.dir === 'string' && patch.lora.dir.trim() !== '') {
          dst.dir = patch.lora.dir.trim()
        }
        merged.lora = dst
      }
    }
    // adetailer: null CLEARS the saved settings (the dialog's explicit clear
    // signal); object → store. The dialog always emits the FULL draft (it
    // restores the saved value on open), so replace merged.adetailer wholesale
    // rather than merging — a bogus payload can never poison the session file
    // (same defensive philosophy as `lora`).
    if (patch.adetailer === null) {
      delete merged.adetailer
    } else if (patch.adetailer && typeof patch.adetailer === 'object') {
      merged.adetailer = patch.adetailer as AdetailerSettings
    }
    // ipAdapter: null CLEARS the saved settings; object → store.
    if (patch.ipAdapter === null) {
      delete merged.ipAdapter
    } else if (patch.ipAdapter && typeof patch.ipAdapter === 'object') {
      merged.ipAdapter = patch.ipAdapter as SessionIpAdapter
    }
    // controlNet: null CLEARS the saved settings; object → store.
    if (patch.controlNet === null) {
      delete merged.controlNet
    } else if (patch.controlNet && typeof patch.controlNet === 'object') {
      merged.controlNet = patch.controlNet as SessionControlNet
    }
    s.inputs = merged
    write(s)
    return s
  }

  return {
    list,
    get: read,
    create,
    rename,
    remove,
    addMessage,
    updateMessage,
    removeMessage,
    setInputs
  }
}
