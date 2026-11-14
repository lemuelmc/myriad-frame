/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Download manager — module-level singleton (not a factory) so the init
 * pipeline (index.ts) and the IPC handlers (ipc.ts) share the same in-flight
 * maps and registry. All data paths are resolved lazily inside functions
 * because `dataRoot()` reads `app.getPath('userData')`, which throws before
 * `app` is ready (same pattern as settings.ts).
 *
 * Responsibilities:
 *  - Persisted model-download registry (data/downloads.json), keyed by URL.
 *  - Staged downloads: fetch to data/tmp/, size-verify, then rename to the real
 *    destination so the live tree never holds partial files.
 *  - Runtime (sd-cli) download in-flight state (moved out of runtime.ts).
 *  - Single source of `models:progress` / `runtime:progress` (via installed
 *    broadcasters, throttled per key to ~one message per 100 ms) and
 *    `downloads:changed` (via onChange subscribers).
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DownloadEntry, DownloadsListResult, ModelType } from '@shared/types'
import { dataRoot } from './data'
import { DownloadAbortError, downloadFile, headSize } from './download'
import { createSettingsService } from './settings'
import { loadRuntimeConfig } from './config'
// Name-hygiene helpers live in a neutral leaf module (NOT in models.ts —
// models.ts already imports this module, and a back-edge would create a
// module cycle whose safety depends on import order; see modelname.ts).
import { baseNameOf, safeModelName } from './modelname'

const MAX_MODEL_CONCURRENT = 2

type RuntimePhase = 'downloading' | 'extracting'

interface RuntimeInflight {
  promise: Promise<void>
  phase: RuntimePhase
  progress: { downloadedBytes: number; totalBytes: number }
  controllers: Map<string, AbortController>
  onProgress: (p: { downloadedBytes: number; totalBytes: number; phase?: RuntimePhase }) => void
}

interface ModelInflight {
  url: string
  promise: Promise<string>
  abortController: AbortController
  resolve: (p: string) => void
  reject: (e: unknown) => void
  work: () => Promise<void>
}

/** Live byte counts for a model URL, re-emitted on completion before onChange. */
interface LastProgress {
  downloadedBytes: number
  totalBytes: number
}

type ChangeCallback = (list: DownloadsListResult) => void
export type ModelProgressBroadcaster = (p: {
  type: ModelType
  url: string
  downloadedBytes: number
  totalBytes: number
}) => void
export type RuntimeProgressBroadcaster = (p: {
  version: string
  downloadedBytes: number
  totalBytes: number
  phase?: RuntimePhase
}) => void

/**
 * The source-aware model-download chokepoint signature — installed by
 * models.ts via `setModelDownloadFn` so background retries route through the
 * source registry too.
 */
export type ModelDownloadFn = (
  type: ModelType,
  url: string,
  provider: string,
  force: boolean
) => Promise<string>

// ---------- module state ----------
/**
 * The manager's mutable state lives in ONE object stored on `globalThis`
 * under a fixed key, not in plain module-scope variables. Reason: the main
 * bundle has been observed to emit this module TWICE (two independent module
 * instances — `data.ts`, `settings.ts` and `downloads.ts` each appear twice
 * in out/main/index.js), which split the manager's brain: downloads started
 * through models.ts's `downloadModel` ran on one copy's maps while
 * `downloads:list` / `downloads:cancel` / pause and `startAllPending`
 * operated on the other's — so the same URL could be downloaded twice
 * concurrently into the identical staged temp path (the copies deleted each
 * other's staged file → ENOENT at rename), and cancel/pause could never
 * touch in-flight downloads. A globalThis singleton makes every module copy
 * share one state object regardless of how the bundler instantiates it.
 */
interface DownloadsState {
  registry: Map<string, DownloadEntry>
  modelMap: Map<string, ModelInflight>
  waitQueue: ModelInflight[]
  activeCount: number
  paused: boolean
  runtimeMap: Map<string, RuntimeInflight>
  changeSubscribers: Set<ChangeCallback>
  lastProgress: Map<string, LastProgress>
  modelBroadcaster?: ModelProgressBroadcaster
  runtimeBroadcaster?: RuntimeProgressBroadcaster
  /**
   * The source-aware model-download chokepoint used by startAllPending()
   * background retries. Lives ON the shared globalThis state (never a
   * module-scope variable): this module is emitted TWICE in the built bundle,
   * and a per-copy hook would be set on one copy while the other copy's
   * startAllPending() reads `undefined` — silently bypassing the source for
   * every background retry. Populated by models.ts at module load.
   */
  modelDownloadFn?: ModelDownloadFn
}

const globalForDownloads = globalThis as typeof globalThis & {
  __myriadFrameDownloadsState?: DownloadsState
}

const state: DownloadsState = (globalForDownloads.__myriadFrameDownloadsState ??= {
  registry: new Map<string, DownloadEntry>(),
  modelMap: new Map<string, ModelInflight>(),
  waitQueue: [],
  activeCount: 0,
  paused: false,
  runtimeMap: new Map<string, RuntimeInflight>(),
  changeSubscribers: new Set<ChangeCallback>(),
  lastProgress: new Map<string, LastProgress>(),
  modelDownloadFn: undefined
})

const settingsService = createSettingsService()

// ---------- lazy path helpers ----------
function registryPath(): string {
  return join(dataRoot(), 'downloads.json')
}
function tmpRoot(): string {
  return join(dataRoot(), 'tmp')
}
function modelTmpDir(type: ModelType, provider: string): string {
  return join(tmpRoot(), 'models', type, provider)
}

/**
 * Staged temp file for a model download — **unique per URL** (sha1 of the
 * URL, 12 hex chars, `.part` suffix). The path used to be derived from the
 * basename alone, so two different URLs sharing type+provider+basename —
 * e.g. the same file listed by a stale and a refreshed catalog, or the same
 * URL downloaded by two app instances — shared one temp path, and one
 * download's start-of-fetch `rmSync(tmp)` deleted the other's just-verified
 * staged file between its exists-check and the rename (ENOENT).
 */
function modelTmpPath(type: ModelType, provider: string, url: string): string {
  const h = createHash('sha1').update(url).digest('hex').slice(0, 12)
  return join(modelTmpDir(type, provider), `${entryName(url)}.${h}.part`)
}
function modelDestDir(type: ModelType, provider: string, diffusionType?: string): string {
  // Family-scoped destination (model-collision-hardening plan §2.1):
  // models/<type>/<diffusionType>/<provider> — so two catalog entries that
  // share a provider + basename but belong to different diffusion families
  // (SD3.5 vs Flux clip_l, SDXL vs Z-Image jrd_2212) can never share or
  // overwrite one on-disk file. `lora` is exempt IN CODE, not just in prose
  // (§2.2): one LoRA URL serves several diffusion types (the catalog expands
  // one entry per `families` member), so nesting per family would
  // fork the join-by-URL into re-download loops — LoRA keeps
  // lora/<provider>/<name>. An unknown family (catalog miss) degrades to the
  // legacy provider-level dest; the resolution chain keeps such files
  // reachable and the next catalog rebuild + re-download heals placement.
  if (diffusionType !== undefined && diffusionType.trim() !== '' && type !== 'lora' && type !== 'ip_adapter' && type !== 'clip_vision' && type !== 'control_net') {
    return join(dataRoot(), 'models', type, diffusionType, provider)
  }
  return join(dataRoot(), 'models', type, provider)
}

/**
 * The final destination for a model download — the ONE place the dest is
 * computed, used by BOTH the installed short-circuit (downloadModel) and
 * runModelDownload, so the two can never disagree about where a URL's file
 * lives (a disagreeing pair would make the short-circuit miss a file the
 * manager just placed — or accept one it placed elsewhere).
 */
function modelDestPath(
  type: ModelType,
  provider: string,
  url: string,
  filename?: string,
  diffusionType?: string
): string {
  return join(modelDestDir(type, provider, diffusionType), entryName(url, filename))
}
function latestVersion(): string | undefined {
  const cfg = loadRuntimeConfig()
  const versions = Object.keys(cfg.releases).sort((a, b) => Number(b) - Number(a))
  return versions[0]
}

// ---------- registry I/O ----------
function normalizeEntry(raw: Partial<DownloadEntry> & { url: string }): DownloadEntry {
  return {
    type: (raw.type as ModelType) ?? 'diffusion',
    url: raw.url,
    provider: raw.provider ?? 'default',
    name: raw.name ?? basename(new URL(raw.url).pathname),
    startedAt: raw.startedAt ?? Date.now(),
    status: raw.status ?? 'failed',
    force: raw.force,
    error: raw.error
  }
}

function loadRegistry(): void {
  const p = registryPath()
  let raw: string | undefined
  try {
    if (existsSync(p)) {
      raw = readFileSync(p, 'utf-8')
    } else {
      // Torn-write recovery: if downloads.json is missing, fall back to the
      // previously-committed .old snapshot.
      const old = p + '.old'
      if (existsSync(old)) {
        console.warn(`[downloads] downloads.json missing; recovering from downloads.json.old`)
        raw = readFileSync(old, 'utf-8')
      }
    }
  } catch {
    console.warn('[downloads] downloads.json corrupted; starting with an empty registry')
    raw = undefined
  }
  state.registry = new Map<string, DownloadEntry>()
  if (!raw) return
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    console.warn('[downloads] downloads.json unparseable; starting with an empty registry')
    return
  }
  const entries = Array.isArray(data) ? data : (data as { entries?: unknown[] }).entries ?? []
  for (const e of entries) {
    if (e && typeof (e as DownloadEntry).url === 'string') {
      const entry = normalizeEntry(e as DownloadEntry)
      if (entry.url) state.registry.set(entry.url, entry)
    }
  }
}

/**
 * Write the registry atomically with a torn-write-proof fallback. Writes to a
 * temp file in the same directory, then two-step renames (Windows `renameSync`
 * does not overwrite an existing destination). At every point downloads.json
 * holds either the old or the new *complete* content.
 */
function saveRegistry(): void {
  const p = registryPath()
  const tmp = p + '.tmp'
  const old = p + '.old'
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(tmp, JSON.stringify({ entries: [...state.registry.values()] }, null, 2))
  rmSync(old, { force: true })
  if (existsSync(p)) renameSync(p, old)
  renameSync(tmp, p)
  rmSync(old, { force: true })
}

function persistRegistry(): void {
  saveRegistry()
  notifyChange()
}

// ---------- change / progress broadcasting ----------
function notifyChange(): void {
  const list = buildList()
  for (const cb of [...state.changeSubscribers]) {
    try {
      cb(list)
    } catch (e) {
      console.warn('[downloads] onChange subscriber error:', (e as Error).message)
    }
  }
}

function buildList(): DownloadsListResult {
  const models: DownloadEntry[] = []
  for (const e of state.registry.values()) {
    // A URL currently queued/in-flight is reported as 'downloading' even though
    // the persisted file only ever holds 'pending'/'failed'.
    const status: DownloadEntry['status'] = state.modelMap.has(e.url) ? 'downloading' : e.status
    models.push({ ...e, status })
  }
  const version = settingsService.get().runtimeVersion ?? latestVersion() ?? ''
  const rstate = getRuntimeState(version)
  return {
    models,
    runtime: {
      version,
      installed: false, // filled in by ipc.ts via runtime.binaryFor()
      downloading: rstate.downloading,
      phase: rstate.phase
    },
    paused: state.paused
  }
}

// ---------- progress broadcast throttling ----------
/**
 * Per-chunk progress callbacks fire for every HTTP data chunk — potentially
 * hundreds of times per second across the concurrent downloads — and every
 * broadcast becomes one IPC message per window. That flood starves the
 * renderer's main thread, so window resize and other UI work turn sluggish
 * while downloads run (software rendering makes it worse). Coalesce
 * broadcasts per key: at most one message per interval, always carrying the
 * LATEST values (leading + trailing throttle). The first update of a burst
 * is sent immediately so rows appear without waiting an interval; the
 * trailing send guarantees a burst's final values are never lost.
 */
const PROGRESS_BROADCAST_INTERVAL_MS = 100

interface ThrottleEntry {
  lastSentAt: number
  timer?: ReturnType<typeof setTimeout>
  /** Invoked at most once per interval; must read CURRENT state, not capture values. */
  send: () => void
}
const throttleMap = new Map<string, ThrottleEntry>()

function throttledSend(key: string, send: () => void): void {
  let entry = throttleMap.get(key)
  if (!entry) {
    entry = { lastSentAt: 0, send }
    throttleMap.set(key, entry)
  } else {
    // Rebind so a pending trailing send always uses the newest closure.
    entry.send = send
  }
  const elapsed = Date.now() - entry.lastSentAt
  if (elapsed >= PROGRESS_BROADCAST_INTERVAL_MS) {
    // Leading edge: due (or first ever) — send now and drop any stale trailing.
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.lastSentAt = Date.now()
    entry.send()
    return
  }
  // Inside the interval: schedule (or keep) a single trailing send.
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      entry.lastSentAt = Date.now()
      entry.send()
    }, PROGRESS_BROADCAST_INTERVAL_MS - elapsed)
  }
}

/** Cancel a pending trailing send without emitting (failure/cleanup paths). */
function cancelThrottled(key: string): void {
  const entry = throttleMap.get(key)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  throttleMap.delete(key)
}

/** Send the latest values for `key` immediately, cancelling any trailing send. */
function flushThrottled(key: string): void {
  const entry = throttleMap.get(key)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
  throttleMap.delete(key)
  entry.send()
}

function notifyModelProgress(type: ModelType, url: string, downloaded: number, total: number): void {
  state.lastProgress.set(url, { downloadedBytes: downloaded, totalBytes: total })
  // The closure reads lastProgress at send time, so a trailing send always
  // carries the latest byte counts.
  throttledSend(`model:${url}`, () => {
    const lp = state.lastProgress.get(url)
    if (lp) state.modelBroadcaster?.({ type, url, downloadedBytes: lp.downloadedBytes, totalBytes: lp.totalBytes })
  })
}

function notifyRuntimeProgress(version: string, p: { downloadedBytes: number; totalBytes: number; phase?: RuntimePhase }): void {
  // The closure reads the in-flight entry at send time (report() keeps it
  // current); when the download has finished the entry is gone and the stale
  // trailing send is dropped instead of resurrecting the progress bar.
  throttledSend(`runtime:${version}`, () => {
    const e = state.runtimeMap.get(version)
    if (!e) return
    state.runtimeBroadcaster?.({ version, downloadedBytes: e.progress.downloadedBytes, totalBytes: e.progress.totalBytes, phase: e.phase })
  })
}

// ---------- registry mutations ----------
/**
 * The stored filename for a model download: the optional source-supplied
 * override wins, else the URL's path basename. The override exists for
 * sources whose download URLs carry no filename in the path (CivitAI's
 * `/api/download/models/<versionId>` — the basename is a bare version ID,
 * which `gen:start`'s extension-filtered basename matching could never
 * resolve). HF URLs end in the filename, so the fallback is byte-identical
 * there.
 */
function entryName(url: string, filename?: string): string {
  // Basename-normalized storage (model-collision-hardening plan §3.1, F7's
  // primary fix): the source-supplied `filename` override is normalized
  // through the SAME '/'-only split as the URL fallback — a slashed catalog
  // name (`sub/dir/file.gguf`, CivitAI's `<versionId>/<filename>`) stores as
  // `file.gguf`, so no layout level ever nests below <provider> and the
  // nested-destination rename failure becomes structurally impossible. The
  // split is '/'-only (baseNameOf — never node:path.basename on the override,
  // which would launder a backslash); a surviving backslash is hostile input
  // and fails fast via safeModelName in downloadModel.
  return baseNameOf(filename ?? basename(new URL(url).pathname))
}

function upsertEntry(
  type: ModelType,
  url: string,
  provider: string | undefined,
  force: boolean,
  filename?: string
): DownloadEntry {
  const existing = state.registry.get(url)
  const entry: DownloadEntry = {
    type,
    url,
    provider: provider || 'default',
    name: entryName(url, filename),
    startedAt: existing?.startedAt ?? Date.now(),
    status: 'pending',
    force: force ?? existing?.force ?? false
  }
  state.registry.set(url, entry)
  saveRegistry()
  return entry
}

function setEntryStatus(url: string, status: DownloadEntry['status'], error?: string): void {
  const e = state.registry.get(url)
  if (!e) return
  e.status = status
  if (error !== undefined) e.error = error
  else delete e.error
  saveRegistry()
}

function removeEntry(url: string): void {
  if (state.registry.delete(url)) saveRegistry()
}

// ---------- concurrency cap / queue ----------
function enqueue(entry: ModelInflight): void {
  if (state.paused || state.activeCount >= MAX_MODEL_CONCURRENT) {
    state.waitQueue.push(entry)
    return
  }
  state.activeCount++
  void runEntry(entry)
}

function startNext(): void {
  if (state.paused) return
  while (state.waitQueue.length > 0 && state.activeCount < MAX_MODEL_CONCURRENT) {
    const entry = state.waitQueue.shift()!
    // An entry aborted while queued (Pause aborts everything in the model
    // map, queued entries included) must be settled here — it never entered
    // runModelDownload, so without this its promise would never settle and a
    // later startAllPending() would join a permanently-pending promise.
    if (entry.abortController.signal.aborted) {
      state.modelMap.delete(entry.url)
      setEntryStatus(entry.url, 'failed', 'Cancelled')
      entry.reject(new DownloadAbortError())
      notifyChange()
      continue
    }
    // Bookkeeping: the slot count must be incremented here too — enqueue()
    // only increments for entries it starts itself. Without this the count
    // drifts negative across completions and the cap silently becomes
    // unlimited.
    state.activeCount++
    void runEntry(entry)
  }
}

async function runEntry(entry: ModelInflight): Promise<void> {
  try {
    await entry.work()
  } finally {
    state.modelMap.delete(entry.url)
    state.activeCount--
    startNext()
  }
}

function errMsg(err: unknown): string {
  if (err instanceof DownloadAbortError) return 'Cancelled'
  return (err as Error).message ?? String(err)
}

// ---------- model download entry point ----------
/**
 * Download a model, staged in data/tmp/ and moved to its real destination only
 * after a full, size-verified fetch. Delegates to the manager so the init
 * pipeline and IPC share one in-flight map and one registry.
 *
 * Order: (1) installed short-circuit, (2) paused check, (3) enqueue.
 */
export async function downloadModel(
  type: ModelType,
  url: string,
  provider?: string,
  force = false,
  /**
   * Optional params threaded to the transport: `headers` — the source
   * layer's auth/custom headers — `filename` — the stored-filename
   * override for sources whose download URLs carry no filename in the path
   * (see entryName) — and `diffusionType` — the family-scoped destination
   * key (model-collision-hardening plan §2.3/§3.1), resolved by
   * downloadViaSource from the cached catalog. `onProgress`/`signal` are
   * deliberately NOT here: the manager is the sole progress broadcaster and
   * owns the in-flight AbortController (forwarding either would
   * double-broadcast / double-abort).
   */
  opts?: {
    headers?: Record<string, string>
    filename?: string
    diffusionType?: string
  }
): Promise<string> {
  const prov = provider || 'default'
  // Path-safety gate (plan §3.4): the derived storage name must be a single
  // clean segment. A hostile name (`..`, a surviving separator, a drive
  // prefix, a reserved device name, control characters) fails the download
  // FAST — never silently rewritten to a different file.
  const storageName = entryName(url, opts?.filename)
  if (safeModelName(storageName) === undefined) {
    console.warn(
      `[downloads] refusing to download — derived storage name is not a safe single segment: ${JSON.stringify(storageName)} (url: ${url})`
    )
    throw new Error(`Unsafe model file name: ${storageName}`)
  }
  // (1) Installed short-circuit — runs before any registry write and before the
  // paused check. When !force and the destination exists and its size matches
  // (or the server is offline / headSize === 0), trust the file and clear any
  // stale registry entry. A genuine size mismatch falls through to a fresh
  // download, replacing a legacy truncated file.
  if (!force) {
    const dest = modelDestPath(type, prov, url, opts?.filename, opts?.diffusionType)
    if (existsSync(dest)) {
      // Authenticated short-circuit probe: without headers a private repo's
      // HEAD answers 401 → headSize resolves 0 → the size check below
      // silently passes anything (auth plan §4 — one of the two in-manager
      // headSize threads).
      const expected = await headSize(url, undefined, undefined, opts?.headers)
      let actual = -1
      try {
        actual = statSync(dest).size
      } catch {
        actual = -1
      }
      if (actual >= 0 && (expected === 0 || actual === expected)) {
        removeEntry(url)
        return dest
      }
    }
  }

  // (2) Paused check — queue the entry as pending (preserving force) so it is
  // auto-retried on Resume, then reject with a clear error.
  if (state.paused) {
    upsertEntry(type, url, provider, force, opts?.filename)
    throw new Error('Downloads are paused')
  }

  // (3) Enqueue (joins an existing in-flight/queued download of the same URL).
  return startModelDownload(type, url, prov, force, opts?.headers, opts?.filename, opts?.diffusionType)
}

function startModelDownload(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean,
  headers?: Record<string, string>,
  filename?: string,
  diffusionType?: string
): Promise<string> {
  // A second request for a URL already queued/in-flight joins the existing
  // promise — no re-enqueue, no double download. The join is UNCONDITIONAL
  // (model-collision-hardening plan F6): the map is URL-keyed, so two
  // non-joined same-URL entries would overwrite each other's map slot (the
  // first becomes uncancelable; the first finisher deletes the second's map
  // entry mid-flight) — a join-guard would corrupt cancel/pause bookkeeping.
  // But a URL requested under a DIFFERENT type is a hub-shape smell: warn
  // naming both. Documented assumption: a URL belongs to exactly one type —
  // true for every current hub.json shape.
  const existing = state.modelMap.get(url)
  if (existing) {
    const joinedType = state.registry.get(url)?.type
    if (joinedType !== undefined && joinedType !== type) {
      console.warn(
        `[downloads] URL ${url} requested as both '${joinedType}' (in flight) and '${type}' — joining the '${joinedType}' download; a URL is assumed to belong to exactly one model type`
      )
    }
    return existing.promise
  }

  // Mark pending + enqueue. The registry write happens here (not in downloadModel)
  // so a fresh download always has an entry to retry from.
  upsertEntry(type, url, provider, force, filename)

  const abortController = new AbortController()
  let resolveFn: (p: string) => void = () => {}
  let rejectFn: (e: unknown) => void = () => {}
  const promise = new Promise<string>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  const entry: ModelInflight = {
    url,
    promise,
    abortController,
    resolve: resolveFn,
    reject: rejectFn,
    // `diffusionType` is captured by the work closure alongside
    // headers/filename, so a join's dest and a fresh download's dest derive
    // identically (plan §3.1).
    work: () => runModelDownload(type, url, provider, force, entry, headers, filename, diffusionType)
  }
  state.modelMap.set(url, entry)
  enqueue(entry)
  // Broadcast the upsert + enqueue immediately: without this a queued entry
  // (concurrency cap full) never appears in the Downloads list until some
  // unrelated state transition fires, and an immediately-started one only
  // surfaces there via progress-driven list pulls.
  notifyChange()
  return promise
}

async function runModelDownload(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean,
  entry: ModelInflight,
  headers?: Record<string, string>,
  filename?: string,
  diffusionType?: string
): Promise<void> {
  const name = entryName(url, filename)
  // Promoted from the wait-list to an active slot: emit the initial 0-byte
  // progress event now (a merely-queued entry emits nothing).
  notifyModelProgress(type, url, 0, 0)
  const tmp = modelTmpPath(type, provider, url)
  try {
    // Same dest derivation as the installed short-circuit (modelDestPath) so
    // a joined download's dest and a fresh download's dest can never disagree
    // (model-collision-hardening plan §3.1).
    const finalDest = modelDestPath(type, provider, url, filename, diffusionType)
    const expected = await downloadToTemp(type, url, provider, entry.abortController.signal, headers)
    // Overwrite warning (plan §3.5, F5): a destination that exists with a
    // DIFFERENT size is the same-(family, provider, basename)-different-URL
    // signature — last download would silently win. No behavior change beyond
    // the warning (a genuine force-redownload of the same file has a matching
    // size and stays silent). When expected === 0 (offline / failed HEAD) the
    // size compare cannot run and the overwrite below happens silently — same
    // as before this warning existed.
    if (existsSync(finalDest) && expected > 0) {
      let existingSize = -1
      try {
        existingSize = statSync(finalDest).size
      } catch {
        existingSize = -1
      }
      if (existingSize >= 0 && existingSize !== expected) {
        console.warn(
          `[downloads] overwriting "${finalDest}" (${existingSize} bytes on disk) with a ${expected}-byte download — same destination slot, different source URL (potential model collision)`
        )
      }
    }
    // Move into place. Windows `renameSync` does not overwrite, so delete any
    // existing destination first (also clears legacy truncated files). A locked
    // destination (active generation holds it open) throws EPERM → "file in use".
    try {
      rmSync(finalDest, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`File in use: ${name}`)
      }
      throw err
    }
    // The staged file can vanish between the fetch and this point when
    // another process wipes data/tmp (a second app instance shares the same
    // userData/data tree and its initDataDirs() clears the whole tmp dir).
    // Fail with a descriptive error instead of a raw ENOENT rename; the
    // entry stays 'failed' and is re-downloaded on the next retry/launch.
    if (!existsSync(tmp)) {
      throw new Error(
        `Staged download for ${name} vanished (data/tmp was wiped by another app instance or a restart) — retry to re-download`
      )
    }
    // The destination directory is created lazily here:
    // initDataDirs()/ensureModelDirs() only create the top-level
    // data/models/<type>/ dirs, and nothing else ever created the nested
    // destination dirs — without this mkdir the final rename fails with
    // ENOENT *on the destination* (the staged file itself was fine). Creating
    // dirname(finalDest) recursively (not the bare provider dir) also covers
    // the family-scoped depth models/<type>/<diffusionType>/<provider>/ and
    // any future layout depth (plan §3.1's defense-in-depth for F7).
    mkdirSync(dirname(finalDest), { recursive: true })
    renameSync(tmp, finalDest)
    removeEntry(url)
    // Emit the final progress event *before* the onChange transition so the
    // renderer holds the 100% state before the settings store prunes the key.
    // flushThrottled (not notifyModelProgress): the terminal event must reach
    // the renderer immediately — a throttled final event would land after the
    // onChange broadcast prunes the live-progress key and resurrect the row.
    flushThrottled(`model:${url}`)
    entry.resolve(finalDest)
    notifyChange()
  } catch (err) {
    // Drop the in-flight entry BEFORE broadcasting: buildList() overrides the
    // registry status to 'downloading' while the URL is still in modelMap, so
    // notifying before this delete pushes a final payload that still says
    // 'downloading' — the renderer then keeps the row's progress bar (and
    // Cancel button) alive even though the download is dead (the stale-bar
    // bug for Cancel and every other failure).
    state.modelMap.delete(url)
    // A pending trailing progress send must not fire after the failure
    // broadcast: applyDownloadsList prunes the failed entry's live-progress
    // key, and a late event would resurrect a stale progress row.
    cancelThrottled(`model:${url}`)
    setEntryStatus(url, 'failed', errMsg(err))
    entry.reject(err)
    notifyChange()
  }
}

/**
 * Fresh full download to a per-URL unique staged path under
 * data/tmp/models/<type>/<provider>/ (see `modelTmpPath`). No existence
 * check — the installed short-circuit is the single "already installed"
 * decision point. Size-verified; rejects on failure.
 *
 * The abort signal covers the HEAD request too: `headSize()` runs BEFORE any
 * byte is fetched, so a Cancel/Pause landing during it used to leave nothing
 * observing the signal until the HEAD finished on its own (up to its 15 s
 * timeout) — the entry stayed reported 'downloading' (spinner bar alive,
 * further Cancel clicks no-op) for that whole window.
 */
async function downloadToTemp(
  type: ModelType,
  url: string,
  provider: string,
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<number> {
  const tmp = modelTmpPath(type, provider, url)
  rmSync(tmp, { force: true })
  // Authenticated size verification (auth plan §4 — the second in-manager
  // headSize thread): without headers a private repo's HEAD answers 401 →
  // expected === 0 → the `expected > 0` guard is false → a truncated private
  // file would pass as complete.
  const expected = await headSize(url, signal, undefined, headers)
  if (signal?.aborted) throw new DownloadAbortError()
  await downloadFile(url, tmp, {
    fresh: true,
    signal,
    headers,
    onProgress: (downloadedBytes, totalBytes) => {
      notifyModelProgress(type, url, downloadedBytes, totalBytes)
    }
  })
  if (!existsSync(tmp)) throw new Error('Download did not complete')
  const actual = statSync(tmp).size
  if (expected > 0 && actual !== expected) {
    rmSync(tmp, { force: true })
    throw new Error(`Download incomplete: expected ${expected} bytes, got ${actual}`)
  }
  // The verified size is consumed by runModelDownload's overwrite warning
  // (plan §3.5): a destination whose on-disk size differs is the
  // different-URL collision signature.
  return expected
}

// ---------- runtime in-flight state (moved out of runtime.ts) ----------
export function trackRuntimeDownload(
  version: string,
  onProgress: (p: { downloadedBytes: number; totalBytes: number; phase?: RuntimePhase }) => void
): {
  signalFor: (url: string) => AbortSignal
  report: (p: { downloadedBytes: number; totalBytes: number; phase?: RuntimePhase }) => void
  finish: (ok: boolean) => void
} {
  const controllers = new Map<string, AbortController>()
  let resolveP: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolveP = res
  })
  let phase: RuntimePhase = 'downloading'
  let progress = { downloadedBytes: 0, totalBytes: 0 }
  state.runtimeMap.set(version, { promise, phase, progress, controllers, onProgress })

  return {
    signalFor(url: string): AbortSignal {
      let c = controllers.get(url)
      if (!c) {
        c = new AbortController()
        controllers.set(url, c)
      }
      return c.signal
    },
    report(p: { downloadedBytes: number; totalBytes: number; phase?: RuntimePhase }): void {
      phase = p.phase ?? 'downloading'
      progress = { downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes }
      const inflight = state.runtimeMap.get(version)
      if (inflight) {
        state.runtimeMap.set(version, { ...inflight, phase, progress })
      }
      onProgress(p)
      notifyRuntimeProgress(version, p)
    },
    finish(ok: boolean): void {
      resolveP()
      state.runtimeMap.delete(version)
      // Drop any pending trailing progress send: the in-flight entry is gone
      // (the broadcast closure would no-op) and the downloads:changed below
      // clears the bar — a late runtime:progress must not resurrect it.
      cancelThrottled(`runtime:${version}`)
      // Broadcast on failure too: a cancelled/failed runtime download must
      // drop out of the Download-section row (and clear the live progress
      // bar) via downloads:changed immediately, not on the next list pull.
      notifyChange()
    }
  }
}

export function runtimeInflight(version: string): Promise<void> | undefined {
  return state.runtimeMap.get(version)?.promise
}

export function getRuntimeState(version: string): {
  downloading: boolean
  phase?: RuntimePhase
  progress: { downloadedBytes: number; totalBytes: number }
} {
  const e = state.runtimeMap.get(version)
  if (!e) return { downloading: false, progress: { downloadedBytes: 0, totalBytes: 0 } }
  return { downloading: true, phase: e.phase, progress: e.progress }
}

// ---------- cancel / pause ----------
function abortModel(url: string): void {
  const e = state.modelMap.get(url)
  if (e) e.abortController.abort()
}

/**
 * Settle a *queued* (not yet fetching) entry immediately: splice it out of the
 * wait queue, drop the in-flight entry, mark the registry 'failed' and reject
 * its promise. Merely aborting a queued entry's signal leaves it reported
 * 'downloading' (buildList overrides by modelMap membership) until a slot
 * frees and startNext() notices the abort — which never happens while paused,
 * so a cancelled/paused queued row would keep its progress bar forever.
 * Callers broadcast the resulting state change.
 */
function settleQueuedEntry(url: string): boolean {
  const qi = state.waitQueue.findIndex((q) => q.url === url)
  if (qi < 0) return false
  const [queued] = state.waitQueue.splice(qi, 1)
  state.modelMap.delete(url)
  setEntryStatus(url, 'failed', 'Cancelled')
  queued.reject(new DownloadAbortError())
  return true
}

function abortAllModelDownloads(): void {
  // Settle queued entries first (they sit in modelMap too); the remaining
  // modelMap entries are actively fetching and take the abort path.
  for (const url of [...state.waitQueue.map((q) => q.url)]) settleQueuedEntry(url)
  for (const url of [...state.modelMap.keys()]) abortModel(url)
}

function abortAllRuntimeDownloads(): void {
  for (const [version, inflight] of [...state.runtimeMap.entries()]) {
    if (inflight.phase === 'extracting') continue
    for (const c of inflight.controllers.values()) c.abort()
  }
}

function wipeRuntimeTempZips(version: string): void {
  const rtTmp = join(tmpRoot(), 'runtime')
  if (!existsSync(rtTmp)) return
  for (const f of readdirSync(rtTmp)) {
    if (!f.startsWith(`sd-${version}-`)) continue
    // Best-effort: the zip that was just aborted is *delete-pending* until its
    // write stream closes (Windows), so unlinking it here throws EPERM. The
    // abort path in download.ts finishes that deletion once the stream closes;
    // this wipe only needs to clear leftovers from earlier attempts.
    try {
      rmSync(join(rtTmp, f), { force: true })
    } catch {
      /* still open / delete-pending — cleaned by the abort path */
    }
  }
}

/**
 * Cancel or remove a download. `arg` is either a runtime **version** (short
 * numeric string) or a model **URL** (full http(s)://). The two namespaces
 * never collide. Probes the runtime map by version first, then treats the value
 * as a model URL. Throws if it matches neither namespace.
 */
export function cancelDownload(arg: string): void {
  // Runtime version: abort all in-flight zips for that version.
  const rt = state.runtimeMap.get(arg)
  if (rt) {
    if (rt.phase === 'extracting') {
      throw new Error('Cannot cancel: runtime is extracting')
    }
    for (const c of rt.controllers.values()) c.abort()
    wipeRuntimeTempZips(arg)
    notifyChange()
    return
  }

  // Model URL: look up the registry entry (pending, failed, or downloading).
  const entry = state.registry.get(arg)
  if (!entry) {
    throw new Error(`No download found for ${arg}`)
  }
  if (state.modelMap.has(arg)) {
    // Queued (waiting for a concurrency slot): settle immediately so this same
    // broadcast flips the row to 'failed'/'Cancelled' instead of leaving its
    // progress bar spinning until a slot frees.
    if (!settleQueuedEntry(arg)) {
      // Actively downloading: abort FIRST and let downloadFile's abort path
      // unlink the staged temp file once its write stream has closed.
      // Unlinking here — while the stream still holds the file open — leaves
      // the file delete-pending on Windows, and the abort handler's own
      // unlink then throws EPERM straight back to the Cancel button (skipping
      // req.destroy()/reject, so the download never settles as cancelled).
      abortModel(arg) // abort → runModelDownload catch marks it failed
    }
  } else {
    // pending/failed but not queued → remove the staged leftover (if any) and
    // drop the entry entirely. Nothing holds the temp file open, but the
    // unlink stays best-effort so an AV/indexer lock can't fail the cancel;
    // the next attempt's fresh pre-clean removes any survivor.
    try {
      rmSync(modelTmpPath(entry.type, entry.provider || 'default', entry.url), { force: true })
    } catch {
      /* leftover cleaned by the next attempt's fresh pre-clean */
    }
    removeEntry(arg) // pending/failed but not queued → remove entirely
  }
  notifyChange()
}

/**
 * Pause or resume model + runtime downloads. Not persisted — a relaunch resumes
 * normal auto-retry. While paused, startAllPending() is a no-op and new model
 * attempts upsert their entry as pending (preserving force) before rejecting.
 */
export function setPaused(pausedValue: boolean): void {
  if (pausedValue === state.paused) return
  state.paused = pausedValue
  if (pausedValue) {
    abortAllModelDownloads()
    abortAllRuntimeDownloads()
  } else {
    startAllPending()
  }
  notifyChange()
}

// ---------- background retries ----------
/**
 * Re-issue every pending + failed entry in the background (oldest first). No-op
 * while paused; per-entry errors are isolated so one failure doesn't stop the
 * rest. Honors `force` so a paused force-redownload is not silently downgraded.
 */
export function startAllPending(): void {
  if (state.paused) return
  const entries = [...state.registry.values()]
    .filter((e) => e.status === 'pending' || e.status === 'failed')
    .sort((a, b) => a.startedAt - b.startedAt)
  for (const e of entries) {
    // Route through the source-aware chokepoint when installed (models.ts
    // sets it at module load); bare downloadModel is the pre-source fallback.
    void (state.modelDownloadFn ?? downloadModel)(e.type, e.url, e.provider, e.force ?? false).catch(
      () => {}
    )
  }
}

// ---------- public list surface ----------
/** Latest runtime version (selected-version fallback for the downloads:list row). */
export function listRuntimeVersion(): string | undefined {
  return latestVersion()
}

/** Whether model + runtime downloads are currently paused (not persisted). */
export function isPaused(): boolean {
  return state.paused
}

/** Persisted registry merged with the in-memory unified download map. */
export function listModels(): DownloadEntry[] {
  return buildList().models
}

// ---------- subscriptions / broadcasters ----------
/** Subscribe to state transitions (not per-byte progress). */
export function onChange(cb: ChangeCallback): void {
  state.changeSubscribers.add(cb)
}

/** Install the callback that broadcasts `models:progress` to all windows. */
export function setModelProgressBroadcaster(cb: ModelProgressBroadcaster): void {
  state.modelBroadcaster = cb
}

/** Install the callback that broadcasts `runtime:progress` to all windows. */
export function setRuntimeProgressBroadcaster(cb: RuntimeProgressBroadcaster): void {
  state.runtimeBroadcaster = cb
}

/**
 * Install the source-aware model-download chokepoint used by startAllPending()
 * background retries. Stored ON the globalThis DownloadsState (never a
 * module-scope variable): the main bundle emits this module TWICE, and a
 * per-copy hook would be set on one copy while the other copy's
 * startAllPending() reads `undefined` — silently bypassing the source for
 * every background retry (a failed private-repo retry would 401 again).
 * A field on the shared state object is visible to every module copy.
 */
export function setModelDownloadFn(fn: ModelDownloadFn): void {
  state.modelDownloadFn = fn
}

// ---------- init ----------
loadRegistry()
