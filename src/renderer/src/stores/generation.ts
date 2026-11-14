/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'

/** In-flight generation state for one session. */
export interface GenerationEntry {
  /** 'converting' — the vid_gen .avi → .mp4 post-processing is running. */
  status: 'running' | 'converting'
  step?: number
  totalSteps?: number
}

/**
 * Per-session in-flight generation state.
 *
 * Generation progress used to live in component-local refs inside
 * ChatPanel.vue, which the activeId watcher wiped on every session switch —
 * switching away and back showed a bare empty assistant bubble while the
 * generation was still running. This store keys the state by sessionId so it
 * survives switches: onGenProgress records it for EVERY session (background
 * included) and ChatPanel mirrors the active session's entry into its local
 * refs. Main's activeGens map stays the source of truth — the renderer
 * rehydrates from `gen:state` on mount / switch (covers a dev reload
 * mid-generation, where this store starts empty).
 */
export const useGenerationStore = defineStore('generation', {
  state: () => ({
    /** sessionId -> in-flight generation state; absent key = idle. */
    gens: {} as Record<string, GenerationEntry>
  }),
  getters: {
    /**
     * True while the given session has a generation in flight. No id =
     * the active session (the common ChatPanel ask).
     */
    isBusy(): (id?: string) => boolean {
      return (id?: string) => (id ? !!this.gens[id] : false)
    },
    /** The entry for one session, or undefined when idle. */
    of(): (id: string) => GenerationEntry | undefined {
      return (id: string) => this.gens[id]
    }
  },
  actions: {
    /** Mark a generation in flight (seeding or a 'running' progress event). */
    markRunning(id: string, step?: number, totalSteps?: number): void {
      this.gens[id] = {
        status: 'running',
        ...(step !== undefined ? { step } : {}),
        ...(totalSteps !== undefined ? { totalSteps } : {})
      }
    },
    /** The .avi → .mp4 post-processing phase (busy indicator stays up). */
    markConverting(id: string): void {
      const e = this.gens[id]
      if (e) e.status = 'converting'
    },
    /** Terminal event (done / stopped / error) — the session is idle again. */
    clear(id: string): void {
      delete this.gens[id]
    }
  }
})
