/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Mask service — the write side of the inpaint / outpaint pipeline.
 *
 * The renderer paints masks on a <canvas> and crosses them over IPC once per
 * Save as PNG data URLs (the renderer has no filesystem access); everything
 * stored afterwards (composer state, request fields, CLI args) is a file path
 * under `data/tmp/masks/`.
 *
 * No purge logic lives here: `initDataDirs()` wipes the whole `data/tmp` tree
 * on every launch, so mask files are ephemeral per app run by construction.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { MaskSaveRequest, MaskSaveResult } from '@shared/types'
import { dataRoot } from './data'

/** The only data-URL prefix accepted — a PNG. */
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
/** Cheap hygiene cap on a single data-URL payload (the plan's 32 MB bound). */
const MAX_PAYLOAD_CHARS = 32 * 1024 * 1024

/** Directory the mask / padded-init PNGs are written to (created on demand). */
export function masksDir(): string {
  return join(dataRoot(), 'tmp', 'masks')
}

/** Validate the data-URL prefix + size cap and decode the base64 body. */
function decodeDataUrl(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Invalid mask payload — expected a base64 PNG data URL')
  }
  if (dataUrl.length > MAX_PAYLOAD_CHARS) {
    throw new Error('Mask image is too large (over 32 MB)')
  }
  return Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
}

/** Write one PNG into masksDir() under a collision-free timestamped name. */
function writePng(buf: Buffer): string {
  const dir = masksDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.png`)
  writeFileSync(path, buf)
  return path
}

/**
 * Persist the renderer's painted mask (and, for outpaint, the padded init
 * image) as PNG files. `initPng` is required when `kind` is 'outpaint' —
 * a padded composition without its init image is a malformed save.
 */
export function saveMask(req: MaskSaveRequest): MaskSaveResult {
  if (req.kind === 'outpaint' && !req.initPng) {
    throw new Error('Outpaint save requires the padded init image')
  }
  const maskPath = writePng(decodeDataUrl(req.maskPng))
  const initPath = req.initPng ? writePng(decodeDataUrl(req.initPng)) : undefined
  return { maskPath, initPath }
}

/**
 * Delete saved mask / init files. Every path is validated to live INSIDE
 * `masksDir()` — the renderer controls the argument list, so a malicious or
 * buggy caller must never be able to delete an arbitrary absolute path.
 * Failures are swallowed: deletion is cleanup, not a user-facing operation.
 */
export function clearMask(paths: string[]): void {
  if (!Array.isArray(paths)) return
  const dir = resolve(masksDir())
  for (const raw of paths) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) continue
    const resolved = resolve(raw)
    if (resolved !== dir && !resolved.startsWith(dir + sep)) continue
    try {
      rmSync(resolved, { force: true })
    } catch {
      /* ignore — the launch wipe covers anything left behind */
    }
  }
}
