/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { DOWNLOAD_ABORTED_MESSAGE } from '@shared/types'

export interface DownloadCallbacks {
  onProgress?: (downloadedBytes: number, totalBytes: number) => void
  /**
   * When aborted, the request is destroyed, the partial temp file is deleted,
   * and the promise rejects with a DownloadAbortError.
   */
  signal?: AbortSignal
  /**
   * When true, any existing partial file at destPath is deleted before the
   * fetch so the Range path can never resume a stale/corrupt file.
   */
  fresh?: boolean
}

/** Error thrown when a download is aborted via its signal. */
export class DownloadAbortError extends Error {
  constructor(message = DOWNLOAD_ABORTED_MESSAGE) {
    super(message)
    this.name = 'DownloadAbortError'
  }
}

/**
 * Best-effort unlink for cleanup paths. Cleanup must never throw: ENOENT is
 * normal (the file is already gone), and on Windows a file whose write handle
 * is still open is *delete-pending* — it still exists on disk but can no
 * longer be opened, so a second unlink throws EPERM. Survivors are removed by
 * the next attempt's `fresh` pre-clean instead.
 */
function safeUnlink(p: string): void {
  try {
    rmSync(p, { force: true })
  } catch {
    /* ignore — cleanup is best-effort */
  }
}

/**
 * Download `url` to `destPath`. Supports HTTP redirects and resuming
 * interrupted downloads via `Range` requests. Verifies the final file size
 * against the server's content-length and deletes the file on mismatch, so
 * a truncated/corrupted model is never silently treated as complete.
 * Returns the final destination path.
 */
export function downloadFile(
  url: string,
  destPath: string,
  cb: DownloadCallbacks = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `fresh`: delete any existing partial before fetching so the Range path
    // can never silently resume a stale/corrupt file.
    if (cb.fresh) rmSync(destPath, { force: true })
    mkdirSync(dirname(destPath), { recursive: true })
    const doFetch = (u: string, redirectsLeft = 5, retried = false): void => {
      // Abort before issuing any request when already cancelled.
      if (cb.signal?.aborted) {
        safeUnlink(destPath)
        reject(new DownloadAbortError())
        return
      }
      const mod = u.startsWith('http://') ? http : https
      // Resume from whatever is already on disk (if any).
      const existing = existsSync(destPath) ? statSync(destPath).size : 0
      const headers: Record<string, string> = {}
      if (existing > 0) headers['Range'] = `bytes=${existing}-`
      // The write stream, tracked for the abort handler: its fd must be
      // released before the partial file can actually be unlinked (Windows
      // delete-pending semantics — see onAbort).
      let fileForAbort: WriteStream | undefined
      const req = mod.get(u, { headers }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects for ${url}`))
            return
          }
          doFetch(new URL(res.headers.location, u).toString(), redirectsLeft - 1, retried)
          return
        }
        if (status === 416) {
          // Range not satisfiable: local file is larger than the remote one.
          // If we already fell back to a fresh download, fail; otherwise
          // delete the stale file and start over once.
          res.resume()
          if (retried) {
            reject(new Error(`Download failed: HTTP 416 for ${u}`))
            return
          }
          rmSync(destPath, { force: true })
          doFetch(u, redirectsLeft, true)
          return
        }
        if (status !== 200 && status !== 206) {
          res.resume()
          reject(new Error(`Download failed: HTTP ${status} for ${u}`))
          return
        }
        const remaining = Number(res.headers['content-length'] ?? 0)
        let offset = 0
        let total = remaining
        if (status === 206 && existing > 0) {
          offset = existing
          total = existing + remaining
        }
        let downloaded = 0
        const file = createWriteStream(destPath, { flags: offset > 0 ? 'a' : 'w' })
        fileForAbort = file
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          cb.onProgress?.(offset + downloaded, total)
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            const finalSize = existsSync(destPath) ? statSync(destPath).size : 0
            if (total > 0 && finalSize !== total) {
              rmSync(destPath, { force: true })
              reject(new Error(`Download incomplete: expected ${total} bytes, got ${finalSize}`))
              return
            }
            resolve(destPath)
          })
        })
        file.on('error', (err) => {
          // Unlink only after the fd is released ('close'): deleting while the
          // stream still holds the file open leaves it delete-pending on
          // Windows and the unlink itself would throw EPERM.
          file.once('close', () => safeUnlink(destPath))
          reject(err)
        })
        res.on('error', reject)
      })
      // Abort: destroy the in-flight request and the write stream, then delete
      // the partial temp file only after the stream's fd is released. Deleting
      // earlier — while the stream still holds the file open — leaves the file
      // delete-pending on Windows: it still exists on disk but can no longer
      // be opened, so this handler's own unlink throws EPERM synchronously out
      // of abort() (the "Cancel failed: EPERM" bug) and skips req.destroy()/
      // reject(), leaving the download unsettled.
      const onAbort = (): void => {
        req.destroy()
        const f = fileForAbort
        if (f) {
          f.destroy()
          f.once('close', () => safeUnlink(destPath))
        } else {
          safeUnlink(destPath)
        }
        reject(new DownloadAbortError())
      }
      if (cb.signal) {
        if (cb.signal.aborted) onAbort()
        else cb.signal.addEventListener('abort', onAbort, { once: true })
      }
      req.on('error', (err) => {
        if (cb.signal?.aborted) return // already rejected via onAbort
        reject(err)
      })
    }
    doFetch(url)
  })
}

/**
 * HEAD request to get content-length (and confirm reachability).
 * Follows HTTP redirects (up to `maxRedirects`) so redirecting hosts —
 * e.g. HuggingFace `resolve/main/...` → CDN — report the real file size
 * rather than the size of the tiny redirect body. Resolves to 0 on any
 * failure (offline, non-200, or no content-length).
 *
 * `signal` (optional) aborts the request: on abort the request is destroyed
 * and the promise resolves 0 immediately, so a Cancel/Pause landing while a
 * caller awaits this HEAD settles the surrounding download right away
 * instead of leaving its row reported 'downloading' (spinner bar alive,
 * further Cancel clicks no-op) until the request finishes — or hits its
 * 15 s timeout — on its own.
 */
export function headSize(
  url: string,
  signal?: AbortSignal,
  redirectsLeft = 5
): Promise<number> {
  return new Promise((resolve) => {
    // Abort before issuing any request when already cancelled.
    if (signal?.aborted) {
      resolve(0)
      return
    }
    const mod = url.startsWith('http://') ? http : https
    const req = mod.request(
      url,
      { method: 'HEAD', timeout: 15000 },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            resolve(0)
            return
          }
          headSize(new URL(res.headers.location, url).toString(), signal, redirectsLeft - 1).then(
            resolve
          )
          return
        }
        if (status === 200) {
          const len = Number(res.headers['content-length'] ?? 0)
          res.resume()
          resolve(len)
          return
        }
        res.resume()
        resolve(0)
      }
    )
    // Abort: destroy the in-flight HEAD request and resolve immediately. The
    // listener deliberately stays attached after settlement — firing later is
    // a harmless no-op (destroy on a finished request, resolve on a settled
    // promise), mirroring fetchText's trailing-event tolerance.
    const onAbort = (): void => {
      req.destroy()
      resolve(0)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', () => resolve(0))
    req.on('timeout', () => {
      req.destroy()
      resolve(0)
    })
    req.end()
  })
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}

/**
 * GET `url` and resolve the response body as text. Used for small text
 * resources (e.g. the remote runtime.json config fetched by the
 * `runtime:checkUpdates` handler). Mirrors `headSize`'s redirect handling
 * and 15 s timeout, and `downloadFile`'s explicit stream error handling:
 * - follows HTTP redirects (up to 5)
 * - rejects on non-200 with the HTTP status in the message
 *   (raw.githubusercontent.com occasionally answers 403/429)
 * - caps the accumulated body at 1 MB (`runtime.json` is ~2 KB; the cap
 *   stops a broken or hostile endpoint from buffering unbounded bytes into
 *   main-process memory)
 * - `res.resume()` on every redirect / non-200 branch drains the socket so
 *   the connection is released instead of leaking on 3xx/404/429
 * - `req.on('error')` (DNS failure, ECONNREFUSED) and `res.on('error')`
 *   (connection reset mid-body) both reject with a descriptive error. The
 *   `req.destroy()` on timeout emits a trailing 'error' event — harmless
 *   (the promise is already settled).
 * - the `timeout` request option is a no-op without a `timeout` listener,
 *   so the listener destroys the request and rejects explicitly
 * - sends a static `User-Agent` (Node's http/https send none by default and
 *   raw.githubusercontent.com may answer 403/429 to unbranded clients)
 */
export function fetchText(url: string, redirectsLeft = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(
      url,
      { headers: { 'User-Agent': 'Myriad-Frame' }, timeout: 15000 },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects for ${url}`))
            return
          }
          fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(
            resolve,
            reject
          )
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`Fetch failed: HTTP ${status} for ${url}`))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > 1024 * 1024) {
            res.destroy()
            reject(new Error(`Response exceeds the 1 MB limit for ${url}`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', (err) => reject(err))
      }
    )
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Fetch timed out after 15 s for ${url}`))
    })
  })
}
