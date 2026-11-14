/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Renderer state for the image upscaler. A small state machine shared by the
// chat-bubble and lightbox entry points:
//
//   idle → dialog → busy → compare → idle
//
// The dialog (UpscaleDialog.vue) and the overlay (UpscaleOverlay.vue) both
// render off this store; `proceed()` invokes the main-process `upscale:start`
// with the ACTIVE session id and routes the outcome to `succeeded`/`failed`.

import { defineStore } from 'pinia'
import type { UpscaleResult } from '@shared/types'
import { toast } from '../toast'
import { useSessionsStore } from './sessions'

export type UpscalePhase = 'idle' | 'dialog' | 'busy' | 'compare'

export const useUpscalerStore = defineStore('upscaler', {
  state: () => ({
    phase: 'idle' as UpscalePhase,
    /** absolute path of the image being upscaled */
    sourcePath: null as string | null,
    /** absolute path of the upscaled result (compare phase) */
    resultPath: null as string | null,
    error: null as string | null
  }),

  actions: {
    /** Open the model-picker dialog for a source image. */
    openDialog(path: string): void {
      if (this.phase === 'busy') return
      this.sourcePath = path
      this.resultPath = null
      this.error = null
      this.phase = 'dialog'
    },

    /** Close the dialog without starting an upscale. */
    cancel(): void {
      if (this.phase !== 'dialog') return
      this.phase = 'idle'
      this.sourcePath = null
      this.error = null
    },

    /**
     * Start the upscale: invoke `upscale:start` with the ACTIVE session id,
     * transition dialog → busy, and route the outcome to succeeded/failed.
     */
    async proceed(model: string, provider?: string, diffusionType?: string, tileSize?: number): Promise<void> {
      if (this.phase !== 'dialog' || !this.sourcePath) return
      const sessionsStore = useSessionsStore()
      const sessionId = sessionsStore.activeId
      if (!sessionId) {
        this.error = 'No active session'
        this.phase = 'idle'
        return
      }
      const sourcePath = this.sourcePath
      this.phase = 'busy'
      this.error = null
      try {
        const result = await window.api.upscaleStart({
          sessionId,
          path: sourcePath,
          model,
          provider,
          diffusionType,
          tileSize
        })
        this.succeeded(result)
      } catch (err) {
        this.failed((err as Error).message)
      }
    },

    /** Busy → compare: show the upscaled result on top of the original. */
    succeeded(result: UpscaleResult): void {
      this.resultPath = result.path
      this.phase = 'compare'
    },

    /** Busy → idle: toast the error and close the overlay. */
    failed(err: string): void {
      this.error = err
      this.phase = 'idle'
      this.sourcePath = null
      this.resultPath = null
      toast(err || 'Upscale failed', 'error', 8000)
    },

    /** Close the compare overlay. */
    close(): void {
      if (this.phase !== 'compare') return
      this.phase = 'idle'
      this.resultPath = null
      this.sourcePath = null
      this.error = null
    }
  }
})
