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

import { defineStore } from 'pinia'
import type { Session } from '@shared/types'

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    sessions: [] as Session[],
    activeId: null as string | null
  }),
  getters: {
    active(): Session | null {
      return this.sessions.find((s) => s.id === this.activeId) ?? null
    },
    lastGeneratedImage(): string | undefined {
      const s = this.active
      if (!s) return undefined
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i]
        if (m.role === 'assistant' && m.image) return m.image.path
      }
      return undefined
    }
  },
  actions: {
    async load() {
      this.sessions = await window.api.sessionsList()
      if (!this.activeId && this.sessions.length > 0) this.activeId = this.sessions[0].id
      // First launch: no sessions yet — create one so the user can start
      // typing immediately instead of hitting "No active session".
      if (!this.activeId) await this.create()
    },
    async create(name?: string) {
      const s = await window.api.sessionsCreate(name)
      this.sessions.unshift(s)
      this.activeId = s.id
      return s
    },
    async rename(id: string, name: string) {
      const s = await window.api.sessionsRename(id, name)
      const i = this.sessions.findIndex((x) => x.id === id)
      if (i >= 0) this.sessions[i] = s
    },
    async remove(id: string) {
      await window.api.sessionsRemove(id)
      this.sessions = this.sessions.filter((s) => s.id !== id)
      if (this.activeId === id) this.activeId = this.sessions[0]?.id ?? null
    },
    async removeMessage(messageId: string) {
      if (!this.activeId) return
      const s = await window.api.sessionsRemoveMessage(this.activeId, messageId)
      const i = this.sessions.findIndex((x) => x.id === s.id)
      if (i >= 0) this.sessions[i] = s
    },
    async select(id: string) {
      this.activeId = id
    },
    async refreshActive() {
      if (!this.activeId) return
      const s = await window.api.sessionsGet(this.activeId)
      if (s) {
        const i = this.sessions.findIndex((x) => x.id === s.id)
        if (i >= 0) this.sessions[i] = s
        else this.sessions.unshift(s)
      }
    }
  }
})
