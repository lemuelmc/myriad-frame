/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Session } from '@shared/types'
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

  return { list, get: read, create, rename, remove, addMessage, updateMessage, removeMessage }
}
