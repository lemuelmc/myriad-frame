/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { httpGetJson } from './http'
import { delegateDownload } from './delegate'
import { resolveToken } from './tokens'
import type { DownloadParams, ListFilesOptions, ModelSource, RepoFile } from './model-source'

const CIVITAI_API = 'https://civitai.com/api/v1'

/** A CivitAI model-version file row from the REST API. */
interface CivitaiFile {
  id?: number
  name?: string
  sizeKB?: number
  downloadUrl?: string
  type?: string
  primary?: boolean
}

/** A CivitAI model version from the REST API. */
interface CivitaiVersion {
  id?: number
  name?: string
  files?: CivitaiFile[]
}

/** A CivitAI model from `GET /api/v1/models/:id`. */
interface CivitaiModel {
  id?: number
  name?: string
  modelVersions?: CivitaiVersion[]
}

/**
 * The CivitAI transport. CivitAI has no repos/folders — it has MODELS →
 * VERSIONS → FILES — so the source maps:
 * - model ID   ↔ `repo` slug (the numeric ID string)
 * - version    ↔ a "folder" (its numeric versionId)
 * - file       ↔ a `RepoFile` with path `<versionId>/<fileId>/<filename>`
 *
 * hub.json repo URLs are `https://civitai.com/models/<id>`; downloads go
 * through the official per-version endpoint
 * `https://civitai.com/api/download/models/<versionId>` (a URL whose path
 * carries NO filename — hence the `DownloadParams.filename` override threaded
 * by models.ts from the cached catalog). Registered under the `civitai.com`
 * domain (and the `civitai` name) in `sources/index.ts`; downloading
 * delegates to the generic download manager via the shared `delegateDownload`
 * helper. See plans/civitai-source.md.
 */
export class CivitaiSource implements ModelSource {
  readonly name = 'civitai'
  readonly domains = ['civitai.com']

  /**
   * Memoized versionId → modelId resolutions for download-time auth. The
   * download-time `repo` slug (derived from the download URL by repoFromUrl)
   * is the VERSION id, while token keys are stored per MODEL id
   * (`civitai:<modelId>`) — exact keys need this bridge. Wildcard keys
   * (`civitai:*`) match either slug. Module-level Map, not globalThis: the
   * cache is per-instance warm state, not shared mutable registry state
   * (worst case across a module double-instantiation is one extra API GET).
   */
  private static versionModelCache = new Map<string, string>()

  /**
   * List a CivitAI model's files.
   * - `folder` undefined: every file of every version of the model
   * - `folder` a versionId ("12345"): only that version's files
   * - `folder` '' (empty string): the PRIMARY file of every version — the
   *   "root" of a CivitAI model is its set of primary version files
   * - `options.versionIds` (hub.json `model_version_ids`): when set, only
   *   versions whose id is in the list are listed — combined with the
   *   `folder` semantics above (both filters must pass)
   * Paths are `<versionId>/<fileId>/<filename>` (repo-root-relative in the
   * source's own grammar; the fileId segment lets `resolveUrl` emit the
   * API's per-file download URL — versions routinely carry MULTIPLE files,
   * e.g. a primary Model checkpoint plus a VAE, and the bare per-version
   * endpoint serves only the primary one), sizes are `sizeKB * 1024` bytes.
   *
   * NOTE for hub.json: a CivitAI entry should restrict the scan (`path: '/'`
   * or a versionId) — hub.ts basenames folder-restricted rows, while a
   * whole-repo scan (no `path`) would surface slash-names, which break the
   * basename-based storage/resolution invariants.
   */
  async listFiles(repo: string, folder?: string, options?: ListFilesOptions): Promise<RepoFile[]> {
    if (folder === undefined) {
      console.warn(
        `[civitai] whole-repo scan of model ${repo} — hub.json CivitAI entries should set "path" ("/" for primary files or a versionId) so catalog names stay basename-only`
      )
    }
    const headers = (await this.getAuthHeaders?.(repo)) ?? {}
    // Gated / early-access models enumerate only with the owner's token —
    // the same self-authentication pattern as HuggingFaceSource.listFiles.
    const data = (await httpGetJson(`${CIVITAI_API}/models/${encodeURIComponent(repo)}`, headers)) as CivitaiModel
    const versions = Array.isArray(data.modelVersions) ? data.modelVersions : []
    const files: RepoFile[] = []
    const versionIds = options?.versionIds
    for (const v of versions) {
      if (typeof v.id !== 'number') continue
      // The direct-children semantics: a version IS the folder, so its files
      // are exactly `<versionId>/...` rows — no deeper nesting exists.
      if (folder !== undefined && folder !== '' && folder !== String(v.id)) continue
      // hub.json `model_version_ids` filter: keep only the listed versions
      // (this and the folder filter above must both pass).
      if (versionIds && !versionIds.includes(v.id)) continue
      const rows = Array.isArray(v.files) ? v.files : []
      for (const f of rows) {
        if (typeof f.name !== 'string' || f.name === '') continue
        // Root-only scan (''): primary files only, one per version.
        if (folder === '' && f.primary !== true) continue
        files.push({
          path:
            typeof f.id === 'number'
              ? `${v.id}/${f.id}/${f.name}`
              : `${v.id}/${f.name}`,
          // CivitAI reports sizeKB; the catalog + manager expect bytes.
          ...(typeof f.sizeKB === 'number' ? { size: Math.round(f.sizeKB * 1024) } : {})
        })
      }
    }
    return files
  }

  /**
   * `<versionId>/<fileId>/<filename>` →
   * `https://civitai.com/api/download/models/<versionId>?fileId=<fileId>` —
   * the API's per-file download URL (versions routinely carry MULTIPLE
   * files; the bare endpoint serves only the primary one). Sync and pure —
   * no API call. Accepted degenerate forms: `<versionId>/<filename>` (no
   * fileId → bare per-version endpoint = primary file) and a bare
   * `<versionId>` (the `normalizeFilePath` output shape).
   */
  resolveUrl(repo: string, path: string): string {
    const segs = path.split('/')
    const versionId = segs[0]
    const fileId = segs.length >= 3 ? segs[1] : undefined
    const base = `https://civitai.com/api/download/models/${encodeURIComponent(versionId)}`
    return fileId ? `${base}?fileId=${encodeURIComponent(fileId)}` : base
  }

  /**
   * The source's repo slug from any CivitAI URL — one derivation for both the
   * catalog-build site (repo URL from hub.json) and the download-time site
   * (file URL), so `DownloadParams.repo` is byte-identical to
   * `CatalogEntry.repo`:
   * - `.../models/<id>` (any query string, e.g. `?modelVersionId=`) → `<id>`
   * - `.../api/download/models/<versionId>` → `<versionId>`
   * NOTE the asymmetry with HF: at download time the slug is the VERSION id,
   * not the model id — CivitaiSource.download bridges that for auth.
   */
  repoFromUrl(url: string): string {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    if (segs[0] === 'api' && segs[1] === 'download' && segs[2] === 'models' && segs[3]) {
      return segs[3]
    }
    if (segs[0] === 'models' && segs[1]) return segs[1]
    throw new Error(`Not a CivitAI model/download URL: ${url}`)
  }

  /**
   * Normalize a configured `default` value into the repo-relative path
   * `resolveUrl` expects. Accepted forms:
   * - a full per-file download URL
   *   `.../api/download/models/<versionId>?fileId=<fid>` →
   *   `<versionId>/<fileId>` (the filename is unknown from the URL alone;
   *   resolveUrl accepts a fileId-only path)
   * - a full bare download URL `.../api/download/models/<versionId>` →
   *   `<versionId>`
   * - `<versionId>/<fileId>/<filename>`, `<versionId>/<filename>`, or a bare
   *   `<versionId>` → unchanged
   * Leading slashes are stripped; the HF `resolve/main` grammar does not
   * apply here.
   */
  normalizeFilePath(value: string): string {
    const m = value.match(/^https?:\/\/[^/]+\/api\/download\/models\/([^/?#]+)(?:\?fileId=([^&#]+))?/i)
    if (m) {
      // A full URL may carry other query params (`?token=...` — never
      // persisted); only the fileId selector is kept.
      return m[2] ? `${m[1]}/${m[2]}` : m[1]
    }
    return value.replace(/^\//, '')
  }

  /**
   * Resolve auth headers for `repo` from the token store (data/hub-tokens.json,
   * keyed `civitai:<modelId>` / `civitai:<wildcard>` / `civitai:*` — this
   * source prefixes its own name when consulting the store). {} when the repo
   * has no token. Never throws into the download path; logs only the repo
   * key — NEVER the token.
   */
  async getAuthHeaders(repo: string): Promise<Record<string, string>> {
    const token = resolveToken(this.name, repo)
    if (!token) return {}
    return { Authorization: `Bearer ${token}` }
  }

  /**
   * Auth-aware delegation with the versionId → modelId bridge: the
   * download-time `repo` slug is the VERSION id (derived from the download
   * URL), while exact token keys are stored per MODEL id. Resolution order:
   * (1) token by the slug as-given (covers wildcard keys and the rare
   * version-keyed exact entry), (2) when that misses and the slug is numeric,
   * resolve the model id via `GET /api/v1/model-versions/<vid>` (memoized)
   * and retry — a failed resolution degrades to {} (anonymous download),
   * never throwing into the download. Staging/verify/registry stay with the
   * manager via delegateDownload; the signed-CDN redirect drops the auth
   * header on the cross-host hop (the transports' documented behavior).
   */
  async download(params: DownloadParams): Promise<string> {
    let auth = (await this.getAuthHeaders(params.repo)) ?? {}
    if (!Object.keys(auth).length && /^\d+$/.test(params.repo)) {
      const modelId = await this.resolveModelId(params.repo)
      if (modelId) auth = (await this.getAuthHeaders(modelId)) ?? {}
    }
    // Merge, don't clobber: caller-supplied params.headers survive alongside
    // the resolved auth headers; auth wins on collision.
    return delegateDownload({ ...params, headers: { ...params.headers, ...auth } })
  }

  /**
   * versionId → modelId via the model-versions endpoint, memoized. Returns
   * undefined on any failure (offline, 404, bad shape) — the caller degrades
   * to an anonymous download instead of failing it.
   */
  private async resolveModelId(versionId: string): Promise<string | undefined> {
    const cached = CivitaiSource.versionModelCache.get(versionId)
    if (cached) return cached
    try {
      const headers = (await this.getAuthHeaders(versionId)) ?? {}
      const data = (await httpGetJson(
        `${CIVITAI_API}/model-versions/${encodeURIComponent(versionId)}`,
        headers
      )) as { modelId?: number }
      if (typeof data.modelId !== 'number') return undefined
      const modelId = String(data.modelId)
      CivitaiSource.versionModelCache.set(versionId, modelId)
      return modelId
    } catch {
      return undefined
    }
  }
}
