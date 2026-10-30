/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import log from 'electron-log/main'
import { join } from 'node:path'
import { dataRoot } from './data'

/** Main-process console methods routed through electron-log. */
type PatchedMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

/**
 * Configure electron-log and start capturing main-process console output into
 * `data/logs/latest.log`.
 *
 * - **File target + rolling:** the file transport points at
 *   `data/logs/latest.log`; electron-log's native rolling (`maxSize` + its
 *   default `archiveLogFn`) renames the full file to `latest.old.log` and
 *   starts a fresh `latest.log` — no custom rotation/cleanup code. Worst case
 *   disk usage ≈ 20 MB (10 MB live + 10 MB backup, overwritten per roll).
 * - **Main-process console capture:** electron-log 5.4's `initialize()` does
 *   NOT patch the main `console.*` (verified against the installed source — it
 *   only injects a renderer preload and optionally spies renderer consoles),
 *   so the patch is done manually below. It is recursion-safe and
 *   duplicate-free: the logger's console transport echoes to the dev terminal
 *   through the ORIGINAL `console.*` references it captured at require time
 *   (before this patch), and the logger's internals never call the patched
 *   functions. The console transport stays enabled (default) so main-process
 *   output still reaches the dev terminal — the sd-cli spawn command line is
 *   the primary diagnostic for generation failures (see AGENTS.md).
 * - **Renderer path:** renderer console output is NOT captured here — it
 *   arrives via the manual `logs:forward` IPC bridge (see ipc.ts and
 *   src/renderer/src/main.ts). `log.initialize({ preload: false,
 *   spyRendererConsole: false })` is kept as an explicit guard: electron-log's
 *   auto-injected renderer preload / console spy (upstream defaults have
 *   shifted between releases) would combine with the manual bridge and
 *   duplicate renderer lines in `latest.log`. The manual bridge is the single
 *   renderer path.
 * - **Crash capture:** console patching does not catch
 *   `process.on('uncaughtException')` / `'unhandledRejection'` in main.
 *   `errorHandler.startCatching({ showDialog: false })` routes both into the
 *   log; `showDialog: false` is required — the default pops a native error
 *   dialog on every uncaught exception, surprising and useless in a packaged
 *   app where the file log is the diagnostic surface.
 *
 * Call once from index.ts right after `initDataDirs()` (so the `logs` dir
 * exists) and before `registerIpc()`. Module-init output is missed (services
 * are instantiated at ipc.ts import time, before this runs) — accepted.
 */
export function initLogging(): void {
  // 10 MB per file; the default archive hook renames it to latest.old.log.
  log.transports.file.maxSize = 10 * 1024 * 1024
  // Pin the path to the writable data dir (see services/data.ts).
  log.transports.file.resolvePathFn = () => join(dataRoot(), 'logs', 'latest.log')

  // Explicit no-op guard against renderer-line duplication (see doc comment).
  log.initialize({ preload: false, spyRendererConsole: false })

  // Route main-process console output through the logger (see doc comment).
  const methods: readonly PatchedMethod[] = ['log', 'info', 'warn', 'error', 'debug']
  for (const method of methods) {
    console[method] = (...args: unknown[]): void => {
      // 'log' has no electron-log level — info is its natural mapping.
      if (method === 'log') log.info(...args)
      else log[method](...args)
    }
  }

  // Main-process crash capture (see doc comment).
  log.errorHandler.startCatching({ showDialog: false })
}
