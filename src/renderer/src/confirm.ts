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

import { ref } from 'vue'

export interface ConfirmRequest {
  id: number
  message: string
  confirmLabel?: string
  cancelLabel?: string
  resolve: (ok: boolean) => void
}

/**
 * In-app replacement for the native `window.confirm()`.
 *
 * The native dialog blocks the renderer's message loop while open and, on
 * Windows, can leave the page in a state where focus is dropped and clicks
 * on the page are swallowed after the dialog is dismissed. This helper
 * queues confirmations that are rendered by <ConfirmDialog /> instead.
 *
 * Usage: `const ok = await confirm('Delete session "X"?')`
 */
const queue = ref<ConfirmRequest[]>([])
let nextId = 1

export function useConfirm() {
  return { queue }
}

export function confirm(message: string, opts?: { confirmLabel?: string; cancelLabel?: string }): Promise<boolean> {
  const id = nextId++
  return new Promise<boolean>((resolve) => {
    queue.value.push({
      id,
      message,
      confirmLabel: opts?.confirmLabel,
      cancelLabel: opts?.cancelLabel,
      resolve
    })
  })
}

/** Resolve the front of the queue (called by <ConfirmDialog />). */
export function settleConfirm(ok: boolean): void {
  const head = queue.value[0]
  if (!head) return
  queue.value = queue.value.slice(1)
  head.resolve(ok)
}
