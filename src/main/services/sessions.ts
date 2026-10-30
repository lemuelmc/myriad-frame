/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEDULER_MODEL_DEFAULT } from '@shared/types'
import type { ChatMessage, Session, SessionInputs } from '@shared/types'
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
    if (typeof patch.diffusionType === 'string' && patch.diffusionType !== '')
      merged.diffusionType = patch.diffusionType
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
    // semantics); object → whitelist the 5 keys with per-key validation.
    // Width/height are no longer session-overridable.
    if (patch.sampling === null) {
      delete merged.sampling
    } else if (patch.sampling && typeof patch.sampling === 'object') {
      const dst = { ...(merged.sampling ?? {}) }
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      const n = num(patch.sampling.steps)
      if (n !== undefined) dst.steps = n
      const c = num(patch.sampling.cfg)
      if (c !== undefined) dst.cfg = c
      const s = num(patch.sampling.strength)
      if (s !== undefined) dst.strength = s
      const sm = str(patch.sampling.sampler)
      if (sm) dst.sampler = sm
      const sc = patch.sampling.scheduler
      // Normalize "no scheduler" to the sentinel — stored value is always a
      // string, so downstream checks never need a null branch.
      if (sc === null) dst.scheduler = SCHEDULER_MODEL_DEFAULT
      else {
        const v = str(sc)
        if (v) dst.scheduler = v
      }
      if (Object.keys(dst).length) merged.sampling = dst
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
