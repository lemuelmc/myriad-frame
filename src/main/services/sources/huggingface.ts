/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { httpGetJson, httpGetJsonWithHeaders } from './http'
import { delegateDownload } from './delegate'
import { resolveToken } from './tokens'
import type { DownloadParams, ListFilesOptions, ModelSource, RepoFile } from './model-source'

const HF_API = 'https://huggingface.co/api'

/**
 * Extract the `rel="next"` target from an HTTP `Link` header (the ONLY way the
 * HF tree API exposes its next page). `header` is the raw header value
 * (`<url>; rel="next", <url>; rel="prev", …`); the URL is the text between the
 * angle brackets of the segment whose rel is `next`. Returns undefined when
 * the header is absent, malformed, or carries no `next` relation.
 */
function parseNextLink(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(', ') : header
  if (!raw) return undefined
  for (const segment of raw.split(',')) {
    const m = segment.match(/^\s*<([^>]+)>\s*;(?:[^,]*?)?rel\s*=\s*"?next"?/i)
    if (m) return m[1]
  }
  return undefined
}

/**
 * The HuggingFace transport, extracted from hub.ts: repo-tree enumeration
 * (`/api/models/:repo/tree`) + `resolve/main` download URLs. Registered under
 * the `huggingface.co` domain (and the `huggingface` name) in
 * `sources/index.ts`. Downloading delegates to the generic download manager
 * via the shared `delegateDownload` helper.
 */
export class HuggingFaceSource implements ModelSource {
  readonly name = 'huggingface'
  readonly domains = ['huggingface.co']

  /**
   * List files in a HF repo.
   * - `folder` undefined: recursive listing of the whole repo
   * - `folder` a name ("TURBO", "a/b"): only that folder's direct children
   *   (no recursion)
   * - `folder` '' (empty string): only the repo root's direct children
   *   (no recursion) — the `path: "/"` hub.json form
   * The direct-children filter is applied here so the shape diagnostic below
   * can compare the raw response against the filtered result; paths are
   * repo-root-relative either way.
   */
  async listFiles(repo: string, folder?: string, options?: ListFilesOptions): Promise<RepoFile[]> {
    // Self-authenticated tree scan: a private repo enumerates with the same
    // token the downloads use — zero interface changes for buildCatalog
    // (which stays unaware). With no token the scan is anonymous and the
    // pre-existing per-loop scan-failure semantics apply unchanged.
    const headers = (await this.getAuthHeaders?.(repo)) ?? {}
    const rootOnly = folder === ''
    // per-segment encoding: a nested folder ("a/b") must keep its slash —
    // a whole-string encodeURIComponent would emit "a%2Fb", which the HF
    // router does not resolve to the nested path
    const suffix = folder
      ? `/${folder.split('/').map(encodeURIComponent).join('/')}`
      : ''
    // recursion only for the whole-repo scan (folder undefined); folder and
    // root-only ('') scans list direct children, so no recursive param
    const url =
      `${HF_API}/models/${repo}/tree/main${suffix}` +
      (folder === undefined ? '?recursive=true' : '')
    // Optional pagination (hub.json `max_page`, threaded as options.maxPage):
    // the HF tree API pages at 100 files per page and delivers the next page
    // ONLY as an HTTP `Link` header (`rel="next"`), never in the JSON body —
    // so following it requires the response headers (httpGetJsonWithHeaders).
    // maxPage = the maximum number of PAGES to fetch (default 1 = the
    // pre-pagination behavior, byte-identical when absent); the loop stops at
    // the first page with no `rel="next"` link regardless.
    const maxPage = options?.maxPage
    const pages =
      typeof maxPage === 'number' && Number.isFinite(maxPage) && maxPage >= 1
        ? Math.floor(maxPage)
        : 1
    const rows: Array<{ type?: string; path: string; size?: number }> = []
    let nextUrl: string | undefined = url
    for (let page = 0; page < pages && nextUrl; page++) {
      const { data, headers: resHeaders } = await httpGetJsonWithHeaders(nextUrl, headers)
      const batch = data as Array<{ type?: string; path: string; size?: number }>
      if (!Array.isArray(batch)) throw new Error(`unexpected tree response shape for ${nextUrl}`)
      rows.push(...batch)
      nextUrl = parseNextLink(resHeaders['link'])
    }
    const data = rows
    let files = data
      .filter((f) => f.type === 'file')
      .map((f) => ({ path: f.path, size: f.size }))
    if (folder !== undefined) {
      // direct children only. Defensive guard — the non-recursive call should
      // already return only immediate children (directories come back as
      // `type: "directory"` and are dropped above), so API quirks can't leak
      // nested files. Repo-root-relative paths either way:
      // - root scan (''): no slash at all
      // - folder scan: the folder prefix and no further slash after it
      files = rootOnly
        ? files.filter((f) => !f.path.includes('/'))
        : files.filter(
            (f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/')
          )
      // shape-mismatch diagnostic: the direct-children filter assumes the
      // non-recursive tree returns repo-root-relative paths. When the raw
      // response had model files but none survived the filter, that
      // assumption is wrong (e.g. folder-relative paths) — say so instead
      // of silently emitting URLs that would 404.
      const isModel = (p: string): boolean => /\.(gguf|safetensors)$/i.test(p)
      const rawHadModels = data.some((f) => f.type === 'file' && isModel(f.path))
      if (rawHadModels && !files.some((f) => isModel(f.path))) {
        console.warn(
          `[hub] ${rootOnly ? 'repo root' : `folder "/${folder}"`} in ${repo}: raw tree response had model files but none survived the direct-children filter — verify the tree API response shape (repo-root-relative paths, no unexpected recursion)`
        )
      }
    }
    return files
  }

  resolveUrl(repo: string, path: string): string {
    return `https://huggingface.co/${repo}/resolve/main/${path}`
  }

  /**
   * First two path segments of any HF file URL (strips scheme, host, and the
   * /resolve/main/<path> tail): .../org/repo/resolve/main/f.gguf → org/repo.
   * The inverse of `resolveUrl` — one derivation for both the catalog-build
   * site (repo URL from hub.json) and the download-time site (file URL), so
   * `DownloadParams.repo` is byte-identical to `CatalogEntry.repo`.
   */
  repoFromUrl(url: string): string {
    return new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/')
  }

  /**
   * Normalize a configured `default` / `defaults[].file` value — which hub.json
   * may express as a repo-relative path (the bundled hub.json uses only this
   * form) or a full download URL — into the repo-relative path `resolveUrl`
   * expects. Repo-relative and leading-slash forms pass through unchanged; a
   * full URL is stripped to its repo-relative tail using THIS source's
   * grammar. The regex is a deliberate fix over the inline original
   * (`[^/]+/[^/]+/resolve/main/` could only match a ONE-segment-after-host
   * URL and silently passed a standard two-segment full URL through
   * unstripped): `.+?` matches the minimal `<org>/<repo>` prefix up to the
   * first `/resolve/main/`.
   */
  normalizeFilePath(value: string): string {
    return value
      .replace(/^https?:\/\/[^/]+\/.+?\/resolve\/main\//, '')
      .replace(/^\//, '')
  }

  /**
   * Resolve auth headers for `repo` from the token store
   * (data/hub-tokens.json, keyed `<source-name>:<org/repo>` — this source
   * prefixes its own name when consulting the store). Wildcard keys apply
   * with precedence exact > partial wildcard (longest prefix) > full
   * wildcard — see resolveToken. {} when the repo has no token (public repo
   * / no entry). Never throws into the download path: readTokens degrades to
   * {} on any store problem. Logs only the repo key — NEVER the token.
   */
  async getAuthHeaders(repo: string): Promise<Record<string, string>> {
    const token = resolveToken(this.name, repo)
    if (!token) return {}
    return { Authorization: `Bearer ${token}` }
  }

  /**
   * Auth-aware delegation: resolve this repo's auth headers from the token
   * store and inject them into the shared default-delegation call — only the
   * auth layer changes; staging/verify/registry stay with the manager.
   */
  async download(params: DownloadParams): Promise<string> {
    const auth = (await this.getAuthHeaders?.(params.repo)) ?? {}
    // Merge, don't clobber: caller-supplied params.headers (rare today —
    // downloadViaSource omits it) survive alongside the resolved auth
    // headers; auth wins on collision.
    return delegateDownload({ ...params, headers: { ...params.headers, ...auth } })
  }
}
