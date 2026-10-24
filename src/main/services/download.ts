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

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import https from 'node:https'
import http from 'node:http'

export interface DownloadCallbacks {
  onProgress?: (downloadedBytes: number, totalBytes: number) => void
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
    mkdirSync(dirname(destPath), { recursive: true })
    const doFetch = (u: string, redirectsLeft = 5, retried = false): void => {
      const mod = u.startsWith('http://') ? http : https
      // Resume from whatever is already on disk (if any).
      const existing = existsSync(destPath) ? statSync(destPath).size : 0
      const headers: Record<string, string> = {}
      if (existing > 0) headers['Range'] = `bytes=${existing}-`
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
          rmSync(destPath, { force: true })
          reject(err)
        })
        res.on('error', reject)
      })
      req.on('error', reject)
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
 */
export function headSize(url: string, redirectsLeft = 5): Promise<number> {
  return new Promise((resolve) => {
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
          headSize(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve)
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
