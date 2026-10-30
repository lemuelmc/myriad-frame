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
  lastProgress: new Map<string, LastProgress>()
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
function modelDestDir(type: ModelType, provider: string): string {
  return join(dataRoot(), 'models', type, provider)
}
function latestVersion(): string | undefined {
  const cfg = loadRuntimeConfig()
  const versions = Object.keys(cfg).sort((a, b) => Number(b) - Number(a))
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
function entryName(url: string): string {
  return basename(new URL(url).pathname)
}

function upsertEntry(type: ModelType, url: string, provider: string | undefined, force: boolean): DownloadEntry {
  const existing = state.registry.get(url)
  const entry: DownloadEntry = {
    type,
    url,
    provider: provider || 'default',
    name: entryName(url),
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
  force = false
): Promise<string> {
  const prov = provider || 'default'
  // (1) Installed short-circuit — runs before any registry write and before the
  // paused check. When !force and the destination exists and its size matches
  // (or the server is offline / headSize === 0), trust the file and clear any
  // stale registry entry. A genuine size mismatch falls through to a fresh
  // download, replacing a legacy truncated file.
  if (!force) {
    const dest = join(modelDestDir(type, prov), entryName(url))
    if (existsSync(dest)) {
      const expected = await headSize(url)
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
    upsertEntry(type, url, provider, force)
    throw new Error('Downloads are paused')
  }

  // (3) Enqueue (joins an existing in-flight/queued download of the same URL).
  return startModelDownload(type, url, prov, force)
}

function startModelDownload(
  type: ModelType,
  url: string,
  provider: string,
  force: boolean
): Promise<string> {
  // A second request for a URL already queued/in-flight joins the existing
  // promise — no re-enqueue, no double download.
  const existing = state.modelMap.get(url)
  if (existing) return existing.promise

  // Mark pending + enqueue. The registry write happens here (not in downloadModel)
  // so a fresh download always has an entry to retry from.
  upsertEntry(type, url, provider, force)

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
    work: () => runModelDownload(type, url, provider, force, entry)
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
  entry: ModelInflight
): Promise<void> {
  const name = entryName(url)
  // Promoted from the wait-list to an active slot: emit the initial 0-byte
  // progress event now (a merely-queued entry emits nothing).
  notifyModelProgress(type, url, 0, 0)
  const tmp = modelTmpPath(type, provider, url)
  try {
    const finalDest = join(modelDestDir(type, provider), name)
    await downloadToTemp(type, url, provider, entry.abortController.signal)
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
    // The destination's provider subdirectory is created lazily here:
    // initDataDirs()/ensureModelDirs() only create the top-level
    // data/models/<type>/ dirs, and nothing else ever created
    // data/models/<type>/<provider>/ — without this mkdir the final rename
    // fails with ENOENT *on the destination* (the staged file itself was fine).
    mkdirSync(modelDestDir(type, provider), { recursive: true })
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
  signal?: AbortSignal
): Promise<void> {
  const tmp = modelTmpPath(type, provider, url)
  rmSync(tmp, { force: true })
  const expected = await headSize(url, signal)
  if (signal?.aborted) throw new DownloadAbortError()
  await downloadFile(url, tmp, {
    fresh: true,
    signal,
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
    void downloadModel(e.type, e.url, e.provider, e.force ?? false).catch(() => {})
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

// ---------- init ----------
loadRegistry()
