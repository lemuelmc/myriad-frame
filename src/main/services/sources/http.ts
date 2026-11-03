/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import http from 'node:http'
import https from 'node:https'

/**
 * Small JSON GET helper shared by the model sources (currently just
 * HuggingFaceSource's repo-tree scan). Extracted from hub.ts so hub.ts owns
 * no networking. Behavior is byte-identical to the original inline helper:
 * - follows HTTP redirects (recursively, no explicit hop cap — the original
 *   had none either; HF API redirects are shallow)
 * - rejects on any non-200 with the HTTP status in the message
 * - 20 s request timeout (destroys the request and rejects)
 * - `res.resume()` on the redirect / non-200 branches drains the socket
 *
 * `headers` (optional) are applied to the GET request — the auth layer's
 * per-source Authorization headers, so a private-repo tree scan
 * self-authenticates. The redirect recursion threads the headers on a
 * same-host hop and DROPS the ENTIRE caller-supplied set on a cross-host hop
 * (curl strips Authorization on cross-host redirects by default; auth is
 * expressed only as headers, so dropping the whole set closes the leak class
 * for ANY credential header name). Once dropped, stays dropped. Location may
 * be relative or protocol-relative, so it is resolved against the current
 * hop's URL (the same resolved URL the next hop actually requests) before
 * comparing hosts.
 */
export function httpGetJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  return httpGetJsonWithHeaders(url, headers).then((r) => r.data)
}

/**
 * Same transport as `httpGetJson`, but resolves the response HEADERS alongside
 * the parsed body. Added for HuggingFace tree pagination: the HF tree API
 * delivers the next page as an HTTP `Link` header (`rel="next"`) rather than
 * a field in the JSON body, so the caller must see the headers to follow it.
 * Redirect / timeout / non-200 semantics are identical to `httpGetJson` (the
 * headers resolved are those of the FINAL hop after redirect recursion).
 */
export function httpGetJsonWithHeaders(
  url: string,
  headers?: Record<string, string>
): Promise<{ data: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const req = mod.get(url, headers ? { headers } : {}, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const loc = new URL(res.headers.location, url).toString()
        const crossHost = new URL(loc).host !== new URL(url).host
        if (headers && !crossHost) {
          httpGetJsonWithHeaders(loc, headers).then(resolve, reject)
        } else {
          httpGetJsonWithHeaders(loc).then(resolve, reject)
        }
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString('utf-8')))
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(body), headers: res.headers })
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => {
      req.destroy()
      reject(new Error(`Timeout for ${url}`))
    })
  })
}
