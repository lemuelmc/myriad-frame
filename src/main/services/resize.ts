/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Resize service — the write side of the non-destructive image resize/crop
 * pipeline (plans/image-resize-crop.md).
 *
 * The renderer crops/resizes on a <canvas> (cropperjs) and crosses the result
 * over IPC once per Save as a PNG data URL (the renderer has no filesystem
 * access); everything stored afterwards (composer attachments, request fields)
 * is a file path under `data/tmp/resize/`. The ORIGINAL picked file is never
 * written to — non-destructive by construction.
 *
 * No purge logic lives here: `initDataDirs()` wipes the whole `data/tmp` tree
 * on every launch, so processed images are ephemeral per app run by construction.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResizeSaveResult } from '@shared/types'
import { dataRoot } from './data'

/** The only data-URL prefix accepted — a PNG. */
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
/** Cheap hygiene cap on a single data-URL payload (same bound as masks). */
const MAX_PAYLOAD_CHARS = 32 * 1024 * 1024

/** Directory the resized / cropped PNGs are written to (created on demand). */
export function resizeDir(): string {
  return join(dataRoot(), 'tmp', 'resize')
}

/** Validate the data-URL prefix + size cap and decode the base64 body. */
function decodeDataUrl(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Invalid resize payload — expected a base64 PNG data URL')
  }
  if (dataUrl.length > MAX_PAYLOAD_CHARS) {
    throw new Error('Resized image is too large (over 32 MB)')
  }
  return Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
}

/**
 * Persist the renderer's cropped / resized image as a PNG file under
 * `data/tmp/resize/` under a collision-free timestamped name. The payload is
 * validated BEFORE the directory is created so a malformed call never leaves
 * an empty tree behind.
 */
export function saveResized(png: unknown): ResizeSaveResult {
  const buf = decodeDataUrl(png)
  const dir = resizeDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.png`)
  writeFileSync(path, buf)
  return { path }
}
