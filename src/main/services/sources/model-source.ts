/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { ModelType } from '@shared/types'

/**
 * A model source: the transport half of the hub catalog. A source knows how
 * to (1) enumerate a repo into file rows, (2) resolve a repo-relative path
 * into a downloadable URL, and (3) download a resolved URL (delegating to the
 * generic download manager by default). The catalog builder (`buildCatalog`)
 * owns catalog SHAPE; the source owns TRANSPORT — new model sources
 * (CIVITAI, direct CDN, …) plug in by implementing this interface and
 * registering in `sources/index.ts`, without touching the download pipeline
 * or the catalog-shaping code.
 *
 * These types are main-process only — the renderer never imports them — which
 * is why they live here and not in `shared/types.ts`.
 */

/** A file row returned by a source's repo listing. */
export interface RepoFile {
  path: string // repo-root-relative path
  size?: number
}

export interface DownloadParams {
  /** resolved download URL (e.g. `https://huggingface.co/<repo>/resolve/main/<path>`) */
  url: string
  /**
   * Optional and ignored by the default delegation — the manager resolves the
   * staged temp + final destination internally from `type`/`provider`/`url`
   * (see `modelTmpPath` / `modelDestDir` / `entryName` in downloads.ts).
   * Meaningful only for a fully-owning source that bypasses the manager and
   * drives its own transport.
   */
  destPath?: string
  /**
   * `org/repo` slug (e.g. `unsloth/Qwen-Image-2.1-GGUF`), derived from `url`
   * by the source's `repoFromUrl(url)` (the inverse of `resolveUrl`) — NOT by
   * a generic scheme+host strip, which on a *file* URL
   * (`https://huggingface.co/org/repo/resolve/main/f.gguf`) would yield
   * `org/repo/resolve/main/f.gguf` and break the auth lookup. The auth
   * follow-up's `getAuthHeaders(repo)` looks tokens up by this exact slug —
   * identical to `CatalogEntry.repo`. Populated by `downloadViaSource` in
   * models.ts.
   */
  repo: string
  type: ModelType
  provider?: string
  force?: boolean
  /**
   * `onProgress` is intentionally optional. The default delegation does NOT
   * forward it (the generic manager is the sole progress broadcaster;
   * forwarding would double-broadcast the renderer). Retained only for a
   * fully-owning source that bypasses the manager.
   */
  onProgress?: (downloaded: number, total: number) => void
  /**
   * `signal` is intentionally optional. The default delegation does NOT
   * forward it (the manager owns the in-flight `AbortController` and drives
   * Cancel/Pause). Retained only for a fully-owning source.
   */
  signal?: AbortSignal
  /**
   * auth / custom headers injected on the request (e.g. `Authorization`,
   * `Cookie`). The default download passes these to `downloadFile` via
   * `downloadModel`'s extended params. Optional because public repos need
   * none; a source with no auth simply omits them.
   *
   * Collision nuance: the transport applies these headers AFTER its per-hop
   * `Range` merge, so a caller-supplied `Range` would clobber the resume
   * header and break partial-resume. The auth layer never sends one — a
   * future source must not either.
   */
  headers?: Record<string, string>
  /**
   * Optional stored-filename override for the download manager. Sources whose
   * download URLs carry no filename in the path (e.g. CivitAI's
   * `/api/download/models/<versionId>` — the URL basename is a bare version
   * ID) must supply the real filename here; the manager's `entryName()`
   * falls back to `basename(new URL(url).pathname)` when absent, which is
   * byte-identical for sources whose URLs end in the filename (HF). Resolved
   * by `downloadViaSource` from the cached catalog (`catalogNameForUrl`) —
   * NOT threaded through IPC, so the `models:download` path AND
   * `startAllPending()` background retries resolve it identically.
   */
  filename?: string
 /**
  * Optional diffusionType (family) of the catalog entry this download
  * belongs to — threaded by `downloadViaSource` from the cached catalog
  * (`catalogMetaForUrl`) so the download manager can place the file in the
  * family-scoped destination `models/<type>/<diffusionType>/<provider>/`
  * (model-collision-hardening plan §2.3/§3.1). Absent on a catalog miss →
  * the manager degrades to the legacy provider-level destination. The
  * dedicated sources pass it through untouched (the `{ ...params, headers }`
  * spread carries it); `delegateDownload` forwards it beside
  * `headers`/`filename`.
  */
 diffusionType?: string
}

/**
 * Optional per-scan filters threaded by `buildCatalog` from the hub.json
 * entry fields into `listFiles`. A source that doesn't support a filter
 * simply ignores it (e.g. the HF transport never reads `versionIds`).
 */
export interface ListFilesOptions {
  /**
   * CivitAI version filter (hub.json `model_version_ids`): when present,
   * only the model versions whose ids appear in this list are listed.
   * Ignored by every source except CivitAI.
   */
  versionIds?: number[]
  /**
   * Pagination cap (hub.json `max_page`, HuggingFace entries): the maximum
   * number of PAGES the HF tree scan fetches (the HF tree API pages at 100
   * files per page and exposes the next page only via an HTTP `Link` header).
   * Absent/invalid → 1 page (the pre-pagination behavior). Ignored by every
   * source except HuggingFace.
   */
  maxPage?: number
}

export interface ModelSource {
  /** stable source name (e.g. 'huggingface') — also a registry key for the `source` override */
  readonly name: string
  /**
   * hostnames this source answers for (e.g. ['huggingface.co']) — registry
   * keys. Invariant: a source's *file-download URLs* must be hosted on one of
   * these domains, or download-time routing relies on the `CatalogEntry.source`
   * stamp instead of host matching.
   */
  readonly domains: string[]
  /**
   * List files in a repo (source-specific listing API; e.g. HF
   * /api/models/:repo/tree). `folder` encodes the three-case
   * recursion/direct-children semantics: `undefined` → recursive whole-repo
   * scan; `''` → repo root's direct children only (no recursion); `'a/b'` →
   * that folder's direct children only (no recursion; nested kept intact).
   * `options` carries optional per-scan filters threaded from the hub.json
   * entry (see `ListFilesOptions`) — a source that doesn't support one
   * ignores it.
   */
  listFiles(repo: string, folder?: string, options?: ListFilesOptions): Promise<RepoFile[]>
  /** Resolve a repo-relative path to a downloadable URL (e.g. HF resolve/main). */
  resolveUrl(repo: string, path: string): string
  /**
   * Inverse of `resolveUrl`: derive the source's repo slug from a URL — a
   * *file* download URL at download time
   * (`https://huggingface.co/org/repo/resolve/main/f.gguf` → `org/repo`) and
   * the *repo URL* from hub.json at catalog build. One derivation for both
   * sites: the auth key `DownloadParams.repo` is by construction the same
   * slug as `CatalogEntry.repo`. Source-specific because URL grammars differ.
   */
  repoFromUrl(url: string): string
  /**
   * Normalize a configured `default` / `defaults[].file` value — which hub.json
   * may express as a full download URL or as a repo-relative path — into the
   * repo-relative path `resolveUrl(repo, path)` expects. Optional: when
   * absent, the value is used as-is (correct for sources whose hub.json
   * entries carry repo-relative paths only). This is the source's URL grammar
   * applied to CONFIGURED values — the mirror of `repoFromUrl` (which parses
   * the source's own URLs) — and keeping it on the source is what lets
   * `buildCatalog` stay grammar-agnostic: the HF-shaped `resolve/main`
   * stripping regexes live HERE, not in the catalog builder.
   */
  normalizeFilePath?(value: string): string
  /**
   * Resolve auth headers for a download of `repo` (e.g.
   * { Authorization: 'Bearer <tok>' }). Return {} when no auth is needed
   * (public repo) or when the repo has no configured token. The default
   * implementation returns {} (no auth). Override for private / signed repos.
   * Implementations MUST NOT log the token.
   */
  getAuthHeaders?(repo: string): Promise<Record<string, string>>
  /**
   * Download a resolved URL. The default implementation delegates to the
   * generic download manager (staging/verify/registry). Override when the
   * source needs auth headers / signed URLs / a different transport.
   */
  download(params: DownloadParams): Promise<string>
}
