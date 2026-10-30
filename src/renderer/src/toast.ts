/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

export type ToastKind = 'info' | 'error' | 'ok'

export interface ToastAction {
  label: string
  run: () => void
}

/** Signature of the `window.__toast` hook that Toasts.vue installs. */
export type ToastFn = (t: string, k?: ToastKind, ttl?: number, a?: ToastAction) => void

export function toast(
  text: string,
  kind: ToastKind = 'info',
  ttl = 5000,
  action?: ToastAction
): void {
  const w = window as unknown as { __toast?: ToastFn }
  w.__toast?.(text, kind, ttl, action)
}
