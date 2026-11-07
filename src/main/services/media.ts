/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Privileged `media://` protocol: streams generated video files from disk to
 * the renderer's <video> elements.
 *
 * Why a custom protocol: the previous transport handed the renderer a base64
 * data URL of the whole file. Chromium's media stack cannot stream or seek
 * from a data URL — the player chrome renders but the controls never become
 * interactive. A protocol handler serves the bytes off disk with Range
 * request support (HTTP 206 Partial Content), which is what Chromium's media
 * stack needs for duration probing, seeking, and progressive playback.
 *
 * Security: the handler only serves files inside `data/output/` (generated
 * media lives there). Paths are resolved and containment-checked before any
 * byte is read; anything else gets 403. The renderer never receives raw
 * filesystem access — it only ever holds the opaque `media://` URL.
 */

import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { dataRoot } from './data'

// Privileged-scheme registration MUST happen before app ready — module scope
// guarantees it (this module is imported by index.ts, which is evaluated
// before the whenReady callback runs). `stream: true` is required for the
// streaming Response bodies; `supportFetchAPI` lets the media stack treat it
// like a normal fetchable resource.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/** Video extensions served via the streaming protocol (matches the renderer's isVideo check). */
export function isStreamableVideo(p: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(p)
}

/** Build the opaque media:// URL for a local file (path rides the query string). */
export function mediaUrlFor(p: string): string {
  return `media://local/?path=${encodeURIComponent(p)}`
}

function mimeFor(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mov':
      return 'video/quicktime'
    case 'avi':
      return 'video/x-msvideo'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

/** The single directory tree the protocol is allowed to serve. */
function mediaRoot(): string {
  return resolve(join(dataRoot(), 'output'))
}

/**
 * Install the media:// handler. Call once from app.whenReady(), before any
 * window loads. The handler implements byte-range serving (HTTP 206) so
 * Chromium can seek; a plain 200 with the full stream covers the initial
 * probe. Node streams are bridged to web ReadableStreams via Readable.toWeb.
 */
export function registerMediaProtocol(): void {
  protocol.handle('media', async (req) => {
    try {
      const url = new URL(req.url)
      const raw = url.searchParams.get('path') ?? ''
      if (!raw) return new Response('missing path', { status: 400 })
      const p = resolve(raw)
      // Containment: only files under data/output are ever served. resolve()
      // normalizes `..` traversal attempts, so a resolved-prefix check is
      // sufficient (sep appended so a sibling directory like `output-evil`
      // cannot pass the prefix test).
      if (!p.startsWith(mediaRoot() + sep)) {
        return new Response('forbidden', { status: 403 })
      }
      const s = await stat(p)
      if (!s.isFile()) return new Response('not found', { status: 404 })

      const headers: Record<string, string> = {
        'Content-Type': mimeFor(p),
        'Accept-Ranges': 'bytes'
      }

      const range = req.headers.get('Range')
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
      if (m) {
        let start = m[1] === '' ? undefined : parseInt(m[1], 10)
        let end = m[2] === '' ? undefined : parseInt(m[2], 10)
        if (start === undefined && end !== undefined) {
          // Suffix range (`bytes=-N`): the last N bytes.
          start = Math.max(0, s.size - end)
          end = s.size - 1
        }
        if (end === undefined || end >= s.size) end = s.size - 1
        if (start === undefined || start > end || start >= s.size) {
          // Unsatisfiable range: tell the client the real size.
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${s.size}` }
          })
        }
        const len = end - start + 1
        const stream = createReadStream(p, { start, end })
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Content-Length': String(len)
          }
        })
      }

      return new Response(Readable.toWeb(createReadStream(p)) as unknown as ReadableStream, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(s.size) }
      })
    } catch (e) {
      // Missing file (wiped output dir), permission errors, malformed URLs —
      // all surface as a 500 the <video> element renders as a load failure.
      return new Response(`media error: ${(e as Error).message}`, { status: 500 })
    }
  })
}
