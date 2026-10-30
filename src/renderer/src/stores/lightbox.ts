/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'

/**
 * Global image-lightbox state.
 *
 * Any component can open the lightbox without prop-drilling; the single
 * <ImageLightbox /> instance in App.vue reacts to the store. This mirrors how
 * confirm.ts + ConfirmDialog.vue decouple dialogs from callers.
 */
export const useLightboxStore = defineStore('lightbox', {
  state: () => ({
    /** Path of the image to preview; null = closed. */
    path: null as string | null,
    /** Element that opened the lightbox, kept for focus restore on close. */
    trigger: null as HTMLElement | null
  }),
  actions: {
    open(path: string, trigger?: HTMLElement | null): void {
      this.path = path
      this.trigger = trigger ?? null
    },
    close(): void {
      this.path = null
      const trigger = this.trigger
      this.trigger = null
      // Restore focus to the element that opened the lightbox so keyboard
      // users return to where they came from (skipped when the element was
      // removed from the DOM in the meantime).
      if (trigger && trigger.isConnected) trigger.focus()
    }
  }
})
