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

import type { InitState } from '@shared/types'

/**
 * Current state of the init pipeline.
 *
 * The pipeline can finish before the renderer has mounted and registered its
 * event listeners, in which case every `init:status` / `app:ready` event is
 * lost. The renderer therefore pulls this state on mount to catch up.
 */
let state: InitState = { ready: false, stage: 'platform', message: 'Starting…' }

export function setInitState(patch: Partial<InitState>): void {
  state = { ...state, ...patch }
}

export function getInitState(): InitState {
  return { ...state }
}
