/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { ModelFile, ModelType } from '@shared/types'
import { downloadModel, setModelDownloadFn } from './downloads'
// The source registry (importing './sources' also populates it at module
// load) + the cached catalog's combined URL lookup (source stamp + stored
// filename + diffusionType — ONE parse per download).
import { getSourceForUrl, getSourceForEntry } from './sources'
import {
  catalogMetaForUrl,
  catalogEntriesForLocation,
  catalogBundleForUrl,
  createHubService
} from './hub'
import type { CatalogMeta } from './hub'
import type { ModelSource } from './sources/model-source'
// Name-hygiene helpers (leaf module — no models.ts ↔ downloads.ts cycle).
import { baseNameOf, safeModelName } from './modelname'
// Re-exported so consumers can import them from models.ts (the plan's
// `safeModelName` surface) while the manager imports the leaf directly.
export { baseNameOf, safeModelName }

/**
 * Ensure the canonical data/models layout exists, migrating the legacy
 * `difussion` folder to `diffusion` if present.
 */
import { dataRoot } from './data'

export function ensureModelDirs(): void {
  const root = join(dataRoot(), 'models')
  for (const t of [
    'diffusion',
    'encoder',
    'vae',
    'vision',
    'lora',
    'tokenizer',
    'audio_encoder',
    'audio_vae',
    'latent_upscaler',
    'llm'
  ] as const) {
    mkdirSync(join(root, t), { recursive: true })
  }
  const legacy = join(root, 'difussion')
  if (existsSync(legacy)) {
    const target = join(root, 'diffusion')
    for (const f of readdirSync(legacy)) {
      const from = join(legacy, f)
      const to = join(target, f)
      if (!existsSync(to)) renameSync(from, to)
    }
    rmSync(legacy, { recursive: true, force: true })
  }
}

export function modelsDir(type: ModelType): string {
  return join(dataRoot(), 'models', type)
}

export interface ModelsService {
  list: (type: ModelType) => ModelFile[]
  /**
   * Download a model. `provider` selects the per-provider subdirectory under
   * `data/models/<type>/` (e.g. 'unsloth' → `data/models/diffusion/unsloth/`).
   * Falls back to the legacy flat layout when omitted.
   */
  download: (type: ModelType, url: string, onProgress: (downloadedBytes: number, totalBytes: number) => void, provider?: string, force?: boolean) => Promise<string>
  /**
   * Delete ONE installed file when context is supplied; the legacy
   * delete-all-matches sweep only when no context is (no renderer call site
   * uses that after the collision-hardening change).
   */
  remove: (type: ModelType, name: string, provider?: string, diffusionType?: string, url?: string) => void
  /** Resolve a model file to an absolute path (see pathFor for the chain). */
  pathFor: (type: ModelType, name: string, provider?: string, diffusionType?: string, expectUrl?: string) => string
}

/**
 * The shared routing-precedence resolver — ONE home for the precedence so
 * `downloadViaSource` AND the auth follow-up's `authHeadersForUrl` (which
 * resolves the source again for the `models:verify` probe) can never drift.
 * Precedence: (1) the entry's stamped source name — the post-override
 * resolution made at catalog-build time, read from the CACHED catalog — which
 * covers sources whose file URLs are hosted outside their declared `domains`;
 * (2) plain URL-host matching. Returns `undefined` when neither resolves
 * (each caller decides its own fallback).
 *
 * `meta` is an optional PRE-FETCHED `catalogMetaForUrl(url)` result: the
 * download chokepoint looks the URL up ONCE and threads the same meta here,
 * so the routing hint comes from the same single lookup as the stored
 * filename + diffusionType. Absent → this helper performs its own lookup
 * (the pre-existing behavior).
 */
export function resolveSourceForUrl(url: string, meta?: CatalogMeta): ModelSource | undefined {
  const hint = (meta ?? catalogMetaForUrl(url))?.source
  return (hint ? getSourceForEntry(url, hint) : undefined) ?? getSourceForUrl(url)
}

/**
 * The single-URL download — the source-aware transport for ONE catalog
 * entry. Every model download still consults the source registry; only
 * `downloadViaSource` (below) calls this.
 */
async function downloadSingleViaSource(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean
): Promise<string> {
  // ONE catalog lookup for everything this download needs (model-collision-
  // hardening plan §2.3): the stored-filename override (`meta.name` — for
  // sources whose download URLs carry no filename in the path, e.g. CivitAI's
  // `/api/download/models/<versionId>`), the source routing hint (`meta.source`)
  // and the family-scoped destination key (`meta.diffusionType`). Read here —
  // NOT threaded through IPC — so the `models:download` path AND
  // startAllPending() background retries resolve them identically with zero
  // extra plumbing. Undefined fields on a cache miss → the manager falls back
  // to the URL basename and the legacy provider-level dest (the pre-existing
  // behavior; the resolution chain keeps such files reachable).
  const meta = catalogMetaForUrl(url)
  const source = resolveSourceForUrl(url, meta)
  if (source) {
    // org/repo slug, derived by the source itself (repoFromUrl — the inverse
    // of resolveUrl) so the auth follow-up (model-downloader-auth.md) looks
    // tokens up by this exact slug. A generic scheme+host strip would be
    // WRONG here: `url` is the file download URL (CatalogEntry.url), so
    // stripping scheme + host yields `org/repo/resolve/main/<file>`, not
    // `org/repo`.
    const repo = source.repoFromUrl(url)
    return source.download({
      url,
      repo,
      type,
      provider,
      force,
      filename: meta?.name,
      diffusionType: meta?.diffusionType
      // destPath / onProgress / signal omitted — the default delegation ignores
      // all three (the manager owns progress broadcast + abort; see the
      // source plan §2)
    })
  }
  return downloadModel(type, url, provider, force, {
    filename: meta?.name,
    diffusionType: meta?.diffusionType
  })
}

/**
 * The single source-aware model-download chokepoint. Used by the
 * `models:download` IPC path (via ModelsService.download) AND by
 * downloads.ts.startAllPending background retries (through the
 * `modelDownloadFn` hook installed below), so every model download consults
 * the source registry.
 *
 * **Bundle fan-out** (WAN MoE): when the clicked URL belongs to a
 * multi-member catalog bundle (`catalog[]` items sharing one `groupId` —
 * the low/high-noise diffusion pair), the clicked member downloads first
 * (awaited — its error surfaces to the caller) and the remaining members
 * are enqueued fire-and-forget with `force=false` (the manager's installed
 * short-circuit skips members already on disk; a failed companion shows in
 * the Downloads list and can be retried from there). A single-member bundle
 * (plain entries, or a stale cache) downloads exactly the clicked URL — the
 * pre-existing behavior.
 */
export async function downloadViaSource(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean
): Promise<string> {
  const bundle = catalogBundleForUrl(url)
  if (bundle.length <= 1) return downloadSingleViaSource(type, url, provider, force)
  const clicked = bundle.find((e) => e.url === url) ?? bundle[0]
  const companions = bundle.filter((e) => e.url !== clicked.url)
  const result = await downloadSingleViaSource(type, clicked.url, provider, force)
  for (const c of companions) {
    void downloadSingleViaSource(type, c.url, provider, false).catch((err: unknown) => {
      console.warn(
        `[models] bundle companion download failed (${c.name}): ${(err as Error)?.message ?? String(err)}`
      )
    })
  }
  return result
}

/**
 * Auth headers for an out-of-band probe of `url` — currently the
 * `models:verify` installed-file check in ipc.ts, which calls `headSize`
 * directly OUTSIDE the download manager, so the two in-manager header threads
 * never reach it. Resolves the source through the SAME `resolveSourceForUrl`
 * precedence helper `downloadViaSource` uses — one home for the precedence,
 * no drift — derives the repo slug via `source.repoFromUrl(url)` and returns
 * the source's auth headers. Returns {} when no source matches, the source
 * has no hook, or the auth layer throws (catch → {} — the verify path must
 * never reject because of auth; an anonymous probe falls back to the
 * pre-existing `expected === 0 → ok` semantics).
 *
 * Lives in models.ts, NOT in sources/: hub.ts imports './sources', so a
 * sources → hub back-edge (for catalogSourceForUrl) would cycle the
 * load-time source registration that the source plan's P2.3 warning protects.
 */
export async function authHeadersForUrl(url: string): Promise<Record<string, string>> {
  try {
    const source = resolveSourceForUrl(url)
    if (!source?.getAuthHeaders) return {}
    const repo = source.repoFromUrl(url)
    return (await source.getAuthHeaders(repo)) ?? {}
  } catch {
    return {}
  }
}

// Module scope — runs at import time, before the first startAllPending() call
// in index.ts (index.ts imports ipc.ts, which imports models.ts, and all
// module loads precede app.whenReady()). This ordering is load-bearing: if
// models.ts were first imported after startAllPending() ran, background
// retries would bypass the source. The hook lives ON the globalThis
// DownloadsState (never a module-scope variable), so it is visible to every
// downloads.ts module copy; models.ts itself may also be double-instantiated,
// which is benign — both copies' downloadViaSource are behaviorally
// identical (they consult the same globalThis-backed source registry and
// call downloadModel on copies that share the same globalThis DownloadsState),
// and the last registration wins.
setModelDownloadFn(downloadViaSource)

// ---------- resolution chain (model-collision-hardening plan §3.2) ----------

/**
 * Normalize an optional provider argument the way the download side does
 * (`provider || 'default'`): the requester's own slot is always concretely
 * keyed, so a provider-less request resolves against the 'default' provider
 * dir a provider-less download lands in.
 */
function ownProvider(provider?: string): string {
  return provider !== undefined && provider.trim() !== '' ? provider : 'default'
}

/**
 * The 8-step resolution chain (model-collision-hardening plan §3.2). Checks,
 * in order:
 *
 * 1. `models/<type>/<family>/<provider ?? 'default'>/<name>` — the exact
 *    family-scoped placement new downloads use (ungated)
 * 2. `models/<type>/<family>/<P>/<name>` — sorted provider dirs within the
 *    requested family (URL-gated)
 * 3. `models/<type>/<F>/<provider>/<name>` — cross-family sweep, requested
 *    provider only (URL-gated) — serves shared-URL cross-family files
 * 4. `models/<type>/<provider>/<name>` — legacy per-provider, requested
 *    provider (ungated)
 * 5. `models/<type>/<F>/<P>/<name>` — cross-family sweep, ANY provider
 *    (URL-gated) — must come AFTER step 4 so a wrong-family file can never
 *    shadow the correct legacy same-provider file
 * 6. `models/<type>/<P>/<name>` — sorted legacy provider dirs, any provider
 *    (ungated) — deliberately NOT gated: the renamed-provider promise (the
 *    migration §5) depends on the legacy any-provider sweep staying
 *    permissive
 * 7. `models/<type>/<F>/<name>` — family-root strays (loose files inside a
 *    family dir), any family (ungated) — operationally the same check as
 *    step 6 (a file directly inside a depth-1 dir), kept as a conceptual
 *    step
 * 8. `models/<type>/<name>` — legacy flat (basename-normalized, ungated)
 *
 * **URL gate (steps 2 / 3 / 5)**: a candidate whose location is not the
 * requester's own (family, provider) slot is accepted only when `expectUrl`
 * is undefined (legacy callers — permissive) OR the cached catalog contains
 * an entry at the candidate's exact location `(type, candidateFamily,
 * candidateProvider, basename)` whose `url === expectUrl`. Without the gate,
 * family B's gen:start could silently load family A's same-provider
 * same-basename file downloaded from a DIFFERENT URL — the exact
 * mis-resolution class the plan exists to kill. A gated-out candidate falls
 * through; if nothing resolves the request fails loudly and the user
 * downloads the picked variant.
 *
 * `name` may be a slashed CATALOG name (`sub/dir/file.gguf`) — matched by its
 * '/'-only basename in every step, since stored names are basenames after
 * downloads.ts's basename-normalized storage.
 *
 * Steps 1–3 and 7 need a family context; with `diffusionType` undefined
 * (legacy callers) the chain degenerates to steps 4 / 5 / 6+7 / 8 — the
 * pre-change behavior plus a URL-gated family-depth sweep.
 */
function pathFor(
  type: ModelType,
  name: string,
  provider?: string,
  diffusionType?: string,
  expectUrl?: string
): string {
  const dir = modelsDir(type)
  const base = baseNameOf(name)
  const prov = ownProvider(provider)
  const family =
    diffusionType !== undefined && diffusionType.trim() !== '' ? diffusionType : undefined

  /** The URL gate: open when expectUrl is absent, else the cached catalog
   * must hold an entry at the candidate's exact location carrying that URL. */
  const gate = (candidateFamily: string, candidateProvider: string): boolean => {
    if (expectUrl === undefined) return true
    return catalogEntriesForLocation(type, candidateFamily, candidateProvider, base).some(
      (e) => e.url === expectUrl
    )
  }
  /** Sorted subdirectory names of `parent` (empty when unreadable/absent). */
  const subdirs = (parent: string): string[] => {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  if (family !== undefined) {
    // 1. the requester's own family-scoped slot (ungated — a same-slot file
    // with a different URL is the accepted alternates risk; §3.5 warns on it)
    const own = join(dir, family, prov, base)
    if (existsSync(own)) return own
    // 2. sorted provider dirs within the requested family (URL-gated)
    for (const p of subdirs(join(dir, family))) {
      const c = join(dir, family, p, base)
      if (existsSync(c) && gate(family, p)) return c
    }
    // 3. cross-family sweep, requested provider only (URL-gated) — shared-URL
    // files store under the FIRST catalog family (§2.3); the other families
    // resolve them here.
    for (const f of subdirs(dir)) {
      if (f === family) continue
      const c = join(dir, f, prov, base)
      if (existsSync(c) && gate(f, prov)) return c
    }
  }
  // 4. legacy per-provider, requested provider (ungated — the requester's own
  // legacy-depth slot)
  const ownLegacy = join(dir, prov, base)
  if (existsSync(ownLegacy)) return ownLegacy
  // 5. cross-family sweep, ANY provider (URL-gated) — after step 4, so a
  // wrong-family file cannot shadow the correct legacy same-provider file.
  for (const f of subdirs(dir)) {
    if (family !== undefined && f === family) continue
    for (const p of subdirs(join(dir, f))) {
      const c = join(dir, f, p, base)
      if (existsSync(c) && gate(f, p)) return c
    }
  }
  if (existsSync(dir)) {
    // 6 + 7. legacy any-provider sweep + family-root strays (ungated — the
    // permanent legacy safety net): a file directly inside a depth-1 dir is
    // either a legacy-provider file or a family-root stray; both rank after
    // every context-ful match and before flat.
    for (const d of subdirs(dir)) {
      const c = join(dir, d, base)
      if (existsSync(c)) return c
    }
  }
  // 8. legacy flat (basename-normalized) — also the not-found fallback path.
  return join(dir, base)
}

export function createModelsService(): ModelsService {
  /**
   * Bounded recursive walk (model-collision-hardening plan §3.3). Depth
   * classification:
   * - `<type>/<name>` → flat (provider/diffusionType undefined)
   * - `<type>/<A>/<name>` → legacy provider A — UNLESS A also contains
   *   subdirectories (then A is a family dir and its loose files are
   *   family-root strays with provider undefined — the mixed-dir case)
   * - `<type>/<A>/<B>/<name>` → family A, provider B
   *
   * Bounded at `<type>/<A>/<B>/<name>`: §3.1's single-segment storage rule
   * means no downloaded file ever sits deeper, so the walk is COMPLETE;
   * deeper nesting can only be manual placement, which the walk does not
   * descend into. Duplicate basenames surface as distinct rows.
   */
  function list(type: ModelType): ModelFile[] {
    const dir = modelsDir(type)
    if (!existsSync(dir)) return []
    const out: ModelFile[] = []
    const statFile = (p: string, name: string): ModelFile | null => {
      // A file may be locked-in-use (e.g. an active generation holds it open
      // on Windows), which makes `statSync` throw EPERM. Skip such files
      // rather than aborting the whole listing.
      try {
        const st = statSync(p)
        if (!st.isFile()) return null
        return { name, size: st.size, modifiedAt: st.mtimeMs }
      } catch {
        return null
      }
    }
    const push = (
      p: string,
      name: string,
      provider?: string,
      diffusionType?: string
    ): void => {
      // Path-safety (plan §3.4): a hostile on-disk name is never listed.
      if (safeModelName(name) === undefined) return
      const f = statFile(p, name)
      if (!f) return
      out.push({
        ...f,
        ...(provider !== undefined ? { provider } : {}),
        ...(diffusionType !== undefined ? { diffusionType } : {})
      })
    }
    let top: Dirent[]
    try {
      top = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    // flat files (pre-provider legacy layout)
    for (const ent of top) {
      if (ent.isFile()) push(join(dir, ent.name), ent.name)
    }
    for (const ent of top) {
      if (!ent.isDirectory()) continue
      const sub = join(dir, ent.name)
      let subs: Dirent[]
      try {
        subs = readdirSync(sub, { withFileTypes: true })
      } catch {
        continue
      }
      const hasSubdirs = subs.some((s) => s.isDirectory())
      // Depth-1 direct files: legacy provider files — unless the dir also
      // holds subdirectories (family / mixed dir): then they are
      // family-root strays (provider undefined, family = the dir).
      for (const f of subs) {
        if (!f.isFile()) continue
        if (hasSubdirs) push(join(sub, f.name), f.name, undefined, ent.name)
        else push(join(sub, f.name), f.name, ent.name)
      }
      // Depth-2: <family>/<provider>/<file> (new family-scoped layout).
      for (const s of subs) {
        if (!s.isDirectory()) continue
        const sub2 = join(sub, s.name)
        let files: Dirent[]
        try {
          files = readdirSync(sub2, { withFileTypes: true })
        } catch {
          continue
        }
        for (const f of files) {
          if (f.isFile()) push(join(sub2, f.name), f.name, s.name, ent.name)
          // depth-3 subdirectories are manual placement — not descended
        }
      }
    }
    return out.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.diffusionType ?? '').localeCompare(b.diffusionType ?? '') ||
        (a.provider ?? '').localeCompare(b.provider ?? '')
    )
  }

  async function download(
    type: ModelType,
    url: string,
    _onProgress: (downloadedBytes: number, totalBytes: number) => void,
    provider = 'default',
    force = false
  ): Promise<string> {
    // Route through the source-aware chokepoint: the resolved model source
    // (stamped CatalogEntry.source hint first, then URL-host match) owns the
    // download; a URL with no matching source falls through to the plain
    // manager call (a strict superset of the pre-source behavior). The
    // manager remains the sole source of model progress (models.ts does not
    // broadcast).
    return downloadViaSource(type, url, provider, force)
  }

  /**
   * Delete ONE path when context is supplied (model-collision-hardening plan
   * §3.3, F4's fix — the legacy version deleted the basename in EVERY
   * provider subdir, so deleting Flux's ae.safetensors also deleted
   * Z-Image's VAE of the same name):
   * - `diffusionType` supplied → `<type>/<diffusionType>/<provider ?? 'default'>/<basename(name)>`
   * - only `provider` supplied → `<type>/<provider>/<basename(name)>` (legacy)
   * - neither → `<type>/<basename(name)>` (flat)
   * `name` is basename-normalized (the renderer sends the CATALOG name,
   * which may be slashed). When the direct path is missing and the caller
   * supplies the entry `url` (catalog-entry delete sites do; list-row sites
   * have no url), a gated chain-resolution fallback (§3.2, expectUrl = url)
   * deletes the single path actually serving the request — what makes
   * deleting a shared-URL file from the SECOND family's entry work (the file
   * stores under the first family's dir, §2.3). When two alternates share
   * one slot (same family + provider + basename, different URLs — §3.5),
   * deleting EITHER entry deletes the shared slot file: the storage model
   * holds one file per slot. Without any context the legacy
   * delete-all-matches behavior is kept (no renderer call site uses it).
   */
  function remove(
    type: ModelType,
    name: string,
    provider?: string,
    diffusionType?: string,
    url?: string
  ): void {
    const dir = modelsDir(type)
    const base = baseNameOf(name)
    if (safeModelName(base) === undefined) {
      console.warn(`[models] refusing to delete a hostile model name: ${JSON.stringify(name)}`)
      return
    }
    const prov =
      provider !== undefined && provider.trim() !== '' ? provider : undefined
    const family =
      diffusionType !== undefined && diffusionType.trim() !== '' ? diffusionType : undefined
    if (family !== undefined || prov !== undefined) {
      const direct =
        family !== undefined
          ? join(dir, family, prov ?? 'default', base)
          : join(dir, prov as string, base)
      if (existsSync(direct)) {
        rmSync(direct, { force: true })
        return
      }
      // Gated chain-resolution fallback: resolve the single path that would
      // serve this entry at gen:start (expectUrl = the entry's URL) and
      // delete exactly that — never a sweep.
      if (url !== undefined) {
        const p = pathFor(type, name, provider, diffusionType, url)
        if (existsSync(p)) rmSync(p, { force: true })
      }
      return
    }
    // No context: legacy delete-all-matches behavior (flat + per-provider).
    if (existsSync(join(dir, base))) rmSync(join(dir, base), { force: true })
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry, base)
        if (existsSync(p)) rmSync(p, { force: true })
      }
    }
  }

  return { list, download, remove, pathFor }
}

// ---------- layout migration (model-collision-hardening plan §5) ----------

/**
 * One-time-per-launch migration of legacy-depth model files into the
 * family-scoped layout, using pure `renameSync` moves on the same volume —
 * fast, no re-download. Called from `app.whenReady()` AFTER initLogging() /
 * registerIpc() and BEFORE startAllPending() / createWindow(): no window
 * exists yet (no renderer IPC races) and no background retry can recreate a
 * just-moved legacy file.
 *
 * Algorithm (per type in diffusion, encoder, vae, vision, tokenizer — never
 * lora):
 * 1. Walk `models/<type>/` collecting candidate files at legacy depths only:
 *    flat files, and files inside depth-1 dirs that contain ONLY files
 *    (legacy provider dirs). Family dirs (containing provider subdirs) and
 *    mixed dirs are skipped — this makes the pass idempotent.
 * 2. For each candidate, match cached catalog entries on
 *    `type + provider + basename` (provider normalized `?? 'default'` on
 *    BOTH sides — catalog entries without a configured provider downloaded
 *    under the `default` provider dir) → collect the distinct families (and
 *    URLs):
 *    - 0 matches (manually placed / unknown) → leave in place.
 *    - 1 family → rename to `models/<type>/<family>/<provider || 'default'>/<name>`
 *      (skip when the destination already exists — the legacy copy then
 *      stays in place, shadowed by the family copy at resolution step 1; a
 *      harmless disk duplicate, never deleted).
 *    - ≥2 families, all matching entries share one URL (byte-identical
 *      file, e.g. flux_1 vs flux_1_kontext ae.safetensors) → move to the
 *      first family; the resolution chain serves the others.
 *    - ≥2 families with different URLs (genuinely ambiguous) → leave in
 *      place + warn; the legacy fallback keeps it resolving.
 * 3. Log a summary.
 *
 * Reads the CACHED catalog directly (`createHubService().get()` — the
 * existing instance lives inside runInitPipeline); a missing cache (true
 * first launch) means there are no legacy files to migrate — a natural
 * no-op. Safe to run on every launch.
 */
export function migrateModelLayout(): void {
  const catalog = createHubService().get()
  if (!catalog) return
  const entries = catalog.entries ?? []
  let moved = 0
  let ambiguous = 0
  let unmatched = 0
  for (const type of [
    'diffusion',
    'encoder',
    'vae',
    'vision',
    'tokenizer',
    'audio_encoder',
    'audio_vae',
    'latent_upscaler',
    'llm'
  ] as const) {
    const dir = modelsDir(type)
    if (!existsSync(dir)) continue
    let top: Dirent[]
    try {
      top = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    interface Candidate {
      path: string
      name: string
      providerDir?: string
    }
    const candidates: Candidate[] = []
    for (const ent of top) {
      if (ent.isFile()) {
        candidates.push({ path: join(dir, ent.name), name: ent.name })
      } else if (ent.isDirectory()) {
        const sub = join(dir, ent.name)
        let subs: Dirent[]
        try {
          subs = readdirSync(sub, { withFileTypes: true })
        } catch {
          continue
        }
        // Family dirs (containing provider subdirs) and mixed dirs skip
        // entirely: their files are already family-scoped (or stay as
        // family-root strays resolving via the chain's stray step).
        if (subs.some((s) => s.isDirectory())) continue
        for (const f of subs) {
          if (f.isFile()) {
            candidates.push({ path: join(sub, f.name), name: f.name, providerDir: ent.name })
          }
        }
      }
    }
    for (const c of candidates) {
      const base = baseNameOf(c.name)
      if (safeModelName(base) === undefined) {
        console.warn(`[migration] leaving hostile model file name in place: ${JSON.stringify(c.name)}`)
        unmatched++
        continue
      }
      const wantProv = c.providerDir ?? 'default'
      const matches = entries.filter(
        (e) =>
          e.type === type &&
          (e.provider ?? 'default') === wantProv &&
          baseNameOf(e.name) === base
      )
      const families: string[] = []
      const urls = new Set<string>()
      for (const m of matches) {
        if (!families.includes(m.diffusionType)) families.push(m.diffusionType)
        urls.add(m.url)
      }
      if (families.length === 0) {
        unmatched++
        continue
      }
      let family: string
      if (families.length === 1 || urls.size === 1) {
        // Single family — or several families sharing ONE url (a
        // byte-identical file): move to the first family; the resolution
        // chain's cross-family sweep serves the others.
        family = families[0]
      } else {
        console.warn(
          `[migration] ambiguous file left in place (matches ${families.length} families with different URLs): ${c.path}`
        )
        ambiguous++
        continue
      }
      const dest = join(dir, family, wantProv, base)
      if (existsSync(dest)) continue // family copy already present — legacy copy stays, shadowed
      try {
        mkdirSync(join(dir, family, wantProv), { recursive: true })
        renameSync(c.path, dest)
        moved++
      } catch (e) {
        console.warn(`[migration] rename failed for ${c.path} → ${dest}: ${(e as Error).message}`)
        unmatched++
      }
    }
  }
  console.log(
    `[migration] model layout migration: ${moved} moved, ${ambiguous} left ambiguous, ${unmatched} left unmatched`
  )
}
