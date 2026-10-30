/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import type { LogLevel } from '@shared/types'
import './styles/theme.css'
import './styles/halloween.css'
import './styles/christmas.css'

// ---------- renderer log forwarding (see plans/logging.md) ----------
// Renderer console output and uncaught errors are forwarded to the main
// process over IPC (`logs:forward`) so they land in data/logs/latest.log
// alongside main-process diagnostics. Installed BEFORE createApp()/mount()
// so store initialization and early Vue warnings are captured, not just
// post-mount output.
//
// Always forward — no dev-mode guard: process.env['ELECTRON_RENDERER_URL'] is
// a main-process env var and is not visible here (nodeIntegration is off); if
// a guard is ever wanted, use the Vite build-time flag import.meta.env.DEV.
// The original console behavior is preserved (each wrapper still calls
// through) so dev tools keep showing output.
const consoleLevels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug']
for (const level of consoleLevels) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]): void => {
    try {
      // Fire-and-forget `send` — no await, no response needed.
      window.api.logsForward(level, args)
    } catch {
      // Forwarding must never break the app (api unavailable, IPC closed).
    }
    original(...args)
  }
}

// Uncaught exceptions (the standard DOM 'error' event — 'uncaughtException'
// is a Node process event and does not exist on window) and unhandled
// rejections are forwarded as 'error'-level messages. Errors are stringified
// rather than passed as raw Error objects — simpler and avoids
// structured-clone surprises.
function forwardError(error: unknown): void {
  try {
    const message = error instanceof Error ? (error.stack ?? String(error)) : String(error)
    window.api.logsForward('error', [message])
  } catch {
    // Drop — same rule as the console wrappers above.
  }
}
window.addEventListener('error', (event) => {
  forwardError(event.error ?? event.message ?? 'Unknown error')
})
window.addEventListener('unhandledrejection', (event) => {
  forwardError(event.reason)
})

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
