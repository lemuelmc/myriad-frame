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

export type ToastKind = 'info' | 'error' | 'ok'

export function toast(text: string, kind: ToastKind = 'info', ttl = 5000): void {
  const w = window as unknown as { __toast?: (t: string, k?: ToastKind) => void }
  w.__toast?.(text, kind)
  void ttl
}
