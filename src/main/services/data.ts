/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app } from 'electron'
import { join } from 'node:path'

/**
 * Root of the writable data directory.
 *
 * In a packaged Electron app `app.getAppPath()` points *inside* the read-only
 * `app.asar` archive, so any `mkdirSync`/`writeFileSync` there throws
 * `ENOENT, not a directory`. We therefore keep all runtime data under the
 * user-writable `userData` folder (`~/AppData/.../Local/Programs/Myriad Frame`
 * on Windows) instead, which works in both dev and packaged builds.
 */
export function dataRoot(): string {
  return join(app.getPath('userData'), 'data')
}
