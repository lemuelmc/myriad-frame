/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'

/** Which composer channel the picked images were being added to. */
export type ResizeChannel = 'input' | 'reference'

export interface ResizeQueueItem {
  /** Original picked path — never modified, only read. */
  path: string
  channel: ResizeChannel
}

/**
 * Global resize / crop editor state (plans/image-resize-crop.md).
 *
 * Any component can open the editor without prop-drilling; the single
 * <ResizeCropOverlay /> instance in App.vue reacts to the store — the same
 * decoupling as the lightbox store and confirm.ts.
 *
 * `openEditor()` seeds the queue, opens the overlay and returns a promise that
 * settles when the overlay closes:
 *  - `string[]` — the FINAL path list, 1:1 with the input order (the processed
 *    path under data/tmp/resize where saved, the original path where skipped)
 *  - `null` — the user canceled; the caller attaches nothing
 */
export const useResizeStore = defineStore('resize', {
  state: () => ({
    /** Overlay visibility. */
    open: false,
    /** Images left to process, in pick order. */
    queue: [] as ResizeQueueItem[],
    /** Index of the image currently being edited. */
    index: 0,
    /** Session's diffusion type → resolution presets (null = custom only). */
    diffusionType: null as string | null,
    /** Per-item outcome so far; null = not yet saved/skipped. */
    results: [] as (string | null)[]
  }),
  actions: {
    /**
     * Open the editor for the picked paths. Resolves with the final path list
     * (null on Cancel) once the overlay closes.
     */
    openEditor(
      paths: string[],
      channel: ResizeChannel,
      diffusionType: string | null
    ): Promise<string[] | null> {
      // Defensive: the overlay covers the whole window, so a second open while
      // one is active should be impossible — pass the paths through untouched.
      if (this.open) return Promise.resolve(paths)
      this.queue = paths.map((p) => ({ path: p, channel }))
      this.results = paths.map(() => null)
      this.index = 0
      this.diffusionType = diffusionType
      this.open = true
      return new Promise<string[] | null>((resolve) => {
        settleEditor = resolve
      })
    },
    /** The overlay saved the current image — record the processed path, advance. */
    commitCurrent(processedPath: string): void {
      this.results[this.index] = processedPath
      this.advance()
    },
    /** The overlay skipped the current image — the original passes through. */
    skipCurrent(): void {
      this.results[this.index] = this.queue[this.index]?.path ?? null
      this.advance()
    },
    advance(): void {
      if (this.index + 1 < this.queue.length) {
        this.index += 1
        return
      }
      // Last item done: every slot is filled (commit or skip) — resolve with
      // the final list in the original pick order.
      const final = this.results
        .map((r, i) => r ?? this.queue[i]?.path ?? '')
        .filter((p) => p !== '')
      this.finish(final)
    },
    /** Abort the whole add — the caller attaches nothing. */
    cancelAll(): void {
      this.finish(null)
    },
    /** Close the overlay, clear the queue and settle the caller's promise. */
    finish(outcome: string[] | null): void {
      this.open = false
      this.queue = []
      this.index = 0
      this.diffusionType = null
      this.results = []
      const resolve = settleEditor
      settleEditor = null
      resolve?.(outcome)
    }
  }
})

/** Pending completion for the caller of openEditor() — module-level like confirm.ts. */
let settleEditor: ((paths: string[] | null) => void) | null = null
