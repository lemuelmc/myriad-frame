/**
 * Myriad Frame â€” Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 â€” permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { open as fsOpen } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AllConfigs,
  ChatMessage,
  DownloadProgress,
  GenProgress,
  GenerationRequest,
  HubCatalog,
  HubCheckResult,
  HubConfig,
  LogLevel,
  LogsInfo,
  ModelFile,
  ModelType,
  PlatformInfo,
  ResolutionEntry,
  RuntimeCheckResult,
  RuntimeConfig,
  RuntimeKey,
  RuntimeVersionInfo,
  SamplingDefaults,
  Session,
  SessionInputs,
  Settings,
  ThemeKey
} from '@shared/types'
import {
  loadAllConfigs,
  loadApplicationConfig,
  loadHubConfig,
  loadRuntimeConfig,
  readHubOverride,
  readRuntimeOverride,
  resetHubConfig,
  resetRuntimeConfig,
  saveHubConfig,
  saveRuntimeConfig,
  validateHubConfig,
  validateRuntimeConfig
} from './services/config'
import { DownloadAbortError, fetchText, headSize } from './services/download'
import { createHubService } from './services/hub'
import { getInitState } from './services/init'
import { createModelsService, ensureModelDirs } from './services/models'
import { detectPlatform } from './services/platform'
import { createRuntimeService } from './services/runtime'
import { createSessionsService } from './services/sessions'
import { createSettingsService } from './services/settings'
import { createSdCliService, newOutputPath } from './services/sdcli'
import {
  cancelDownload,
  getRuntimeState,
  listModels,
  listRuntimeVersion,
  onChange,
  isPaused,
  setModelProgressBroadcaster,
  setPaused,
  setRuntimeProgressBroadcaster
} from './services/downloads'
import { SCHEDULER_MODEL_DEFAULT } from '@shared/types'
import type { DownloadsListResult } from '@shared/types'

const hub = createHubService()
const models = createModelsService()
const settings = createSettingsService()
const sessions = createSessionsService()
const runtime = createRuntimeService()
const sdcli = createSdCliService()

/** in-flight generations: sessionId -> { gen, sessionId, messageId } */
const activeGens = new Map<
  string,
  { gen: { child: import('node:child_process').ChildProcess; stopped: boolean }; sessionId: string; messageId: string }
>()

/** Raw source of the up-to-date runtime config (Settings â†’ Runtime â†’ Check). */
const RUNTIME_CONFIG_URL =
  'https://raw.githubusercontent.com/lemuelmc/myriad-frame/master/configurations/runtime.json'

/** Raw source of the up-to-date hub config (Settings â†’ Models â†’ Check). */
const HUB_CONFIG_URL =
  'https://raw.githubusercontent.com/lemuelmc/myriad-frame/master/configurations/hub.json'

/**
 * Recursively sort object keys before stringifying, so the update check's
 * comparison is key-order-stable: a plain `JSON.stringify` is order-sensitive
 * and would report a spurious "updated" (plus a backup) whenever upstream
 * reorders keys with identical content.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableStringify))
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Best-effort serialization for a forwarded renderer console argument
 * (`logs:forward`): strings pass through, everything else is JSON-stringified
 * with a `String()` fallback for non-serializable values.
 */
function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function sendProgress(
  sessionId: string,
  messageId: string,
  p: Omit<GenProgress, 'sessionId' | 'messageId'>
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('gen:progress', { sessionId, messageId, ...p } satisfies GenProgress)
  }
}

function effectiveSampling(diffusionType: string, cfg: AllConfigs): SamplingDefaults {
  const base = cfg.sampling[diffusionType] ?? {
    diffusion_behavior: 'standalone',
    allow_reference: false,
    max_reference: 0,
    img2img: false,
    strength: 0.75,
    steps: 25,
    cfg: 1.0,
    sampler: 'euler',
    scheduler: null,
    negative: null,
    width: 1024,
    height: 1024
  }
  const override = settings.get().sampling?.[diffusionType] ?? {}
  return { ...base, ...override }
}

/**
 * Whether `err` is the manager's expected Pause/Cancel abort rejection.
 * Checks the error name in addition to `instanceof` because the main bundle
 * has been observed to emit service modules twice (two independent module
 * instances â€” see the globalThis singleton note in downloads.ts), and an
 * error created by one copy's DownloadAbortError class would fail the other
 * copy's instanceof check.
 */
function isDownloadAbortError(err: unknown): boolean {
  return (
    err instanceof DownloadAbortError || (err as Error | undefined)?.name === 'DownloadAbortError'
  )
}

export function registerIpc(): void {
  // The download manager is the sole source of `models:progress` and
  // `runtime:progress`; install its broadcasters here so background retries and
  // init-pipeline runtime downloads both surface live progress.
  setModelProgressBroadcaster((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('models:progress', { type: p.type, url: p.url, downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes })
    }
  })
  setRuntimeProgressBroadcaster((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('runtime:progress', { version: p.version, downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes, phase: p.phase })
    }
  })
  // Any registry/state mutation from any call site is surfaced live to the
  // renderer via `downloads:changed` (the full list, so no follow-up invoke).
  onChange((list) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('downloads:changed', list)
    }
  })

  // ---------- downloads ----------
  ipcMain.handle('downloads:list', (): DownloadsListResult => {
    const list = listModels()
    const version = settings.get().runtimeVersion ?? listRuntimeVersion() ?? ''
    const rstate = getRuntimeState(version)
    return {
      models: list,
      runtime: {
        version,
        installed: version !== '' && runtime.binaryFor(version) !== undefined,
        downloading: rstate.downloading,
        phase: rstate.phase
      },
      paused: isPaused()
    }
  })
  ipcMain.handle('downloads:cancel', (_e, arg: string): void => {
    cancelDownload(arg)
  })
  ipcMain.handle('downloads:setPaused', (_e, pausedValue: boolean): void => {
    setPaused(pausedValue)
  })

  // ---------- app / configs ----------
  ipcMain.handle('app:configs', (): AllConfigs => loadAllConfigs())

  // Full init state, so the renderer can catch up on events it missed
  // before it mounted (the pipeline may finish before listeners exist).
  ipcMain.handle('app:initState', () => getInitState())

  ipcMain.handle('app:platform', async (): Promise<PlatformInfo> => detectPlatform())

  ipcMain.handle(
    'app:resolutions',
    (_e, diffusionType: string): ResolutionEntry[] => loadAllConfigs().resolution[diffusionType] ?? []
  )

  ipcMain.handle('app:about', () => {
    const appCfg = loadApplicationConfig()
    return {
      // `name` intentionally carries the *label* (mirrors the previous
      // `hubCfg.label` behavior) â€” the About dialog displays it as the app title.
      name: appCfg.label,
      version: appCfg.version,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform
    }
  })

  ipcMain.handle('app:pickImages', async (): Promise<string[]> => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('app:imageFromPath', (_e, p: string): string => {
    if (!existsSync(p)) return ''
    const buf = readFileSync(p)
    const ext = p.toLowerCase().split('.').pop() ?? 'png'
    const mime =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('app:saveImage', async (_e, imagePath: string): Promise<string | null> => {
    if (!existsSync(imagePath)) return null
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Image',
      defaultPath: basename(imagePath),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      buttonLabel: 'Save'
    })
    if (res.canceled || res.filePath === '') return null
    const fs = await import('node:fs')
    await fs.promises.copyFile(imagePath, res.filePath)
    return res.filePath
  })

  // Reveal a file in the OS file manager (selects it). Returns false when the
  // path no longer exists (e.g. deleted between saving and clicking the link).
  ipcMain.handle('app:showInFolder', (_e, p: string): boolean => {
    if (!existsSync(p)) return false
    shell.showItemInFolder(p)
    return true
  })

  // ---------- runtime ----------
  ipcMain.handle('runtime:versions', (): RuntimeVersionInfo[] => runtime.versions())

  ipcMain.handle(
    'runtime:download',
    async (_e, version: string, key: RuntimeKey): Promise<boolean> => {
      // The manager now broadcasts `runtime:progress`; the init pipeline drives
      // init:status through the onProgress callback, so the handler passes a
      // no-op callback here.
      //
      // Resolves `true` on completion, `false` when Pause/Cancel aborts the
      // download (the manager rejects with DownloadAbortError â€” an expected
      // outcome that must not escape as a handler rejection, which Electron
      // logs as "Error occurred in handler"). The settings store translates
      // `false` back into the DOWNLOAD_ABORTED_MESSAGE error for awaiters.
      try {
        await runtime.download(version, key, () => {})
        return true
      } catch (err) {
        if (isDownloadAbortError(err)) return false
        throw err
      }
    }
  )

  ipcMain.handle('runtime:checkUpdates', async (): Promise<RuntimeCheckResult> => {
    const url = RUNTIME_CONFIG_URL
    console.log(`[runtime:checkUpdates] Fetching runtime config from: ${url}`)

    // Detect a corrupt override *before* fetching: loadRuntimeConfig() falls
    // back silently to the bundled config on parse/shape failure, so it alone
    // cannot surface the problem. On corruption nothing is fetched and no
    // files are touched.
    const override = readRuntimeOverride()
    if (override.status === 'corrupt') {
      console.error('[runtime:checkUpdates] Current runtime config is corrupted')
      throw new Error(
        'Current runtime config is corrupted â€” click Reset in Settings â†’ Runtime (or restore a .bak) and retry'
      )
    }

    let remoteRaw: string
    try {
      remoteRaw = await fetchText(url)
    } catch (e) {
      console.error('[runtime:checkUpdates] Fetch failed:', e)
      throw new Error(`Failed to fetch runtime config from ${url}: ${(e as Error).message}`)
    }

    let remote: RuntimeConfig
    try {
      remote = JSON.parse(remoteRaw) as RuntimeConfig
    } catch (e) {
      console.error('[runtime:checkUpdates] Remote runtime config is not valid JSON:', e)
      throw new Error(`Remote runtime config is not valid JSON: ${(e as Error).message}`)
    }
    const problem = validateRuntimeConfig(remote)
    if (problem) {
      console.error('[runtime:checkUpdates] Remote runtime config is invalid:', problem)
      throw new Error(`Remote runtime config is invalid: ${problem}`)
    }

    // The existing override was already validated by readRuntimeOverride()
    // above, so loadRuntimeConfig() *is* the effective config here (valid
    // override, else bundled). Compare key-order-stable.
    const current = loadRuntimeConfig()
    if (stableStringify(remote) === stableStringify(current)) {
      console.log(
        `[runtime:checkUpdates] Success: no update needed â€” runtime config is up to date`
      )
      return { updated: false, newVersions: [], removedVersions: [] }
    }

    // Backs up the previous override (timestamped .bak) and writes atomically.
    saveRuntimeConfig(remote)

    const remoteKeys = new Set(Object.keys(remote))
    const currentKeys = new Set(Object.keys(current))
    const sortDesc = (a: string, b: string): number => Number(b) - Number(a)
    console.log(
      `[runtime:checkUpdates] Success: runtime config updated â€” new: ${[...remoteKeys]
        .filter((v) => !currentKeys.has(v))
        .sort(sortDesc)
        .join(', ') || '(none)'}; removed: ${[...currentKeys]
        .filter((v) => !remoteKeys.has(v))
        .sort(sortDesc)
        .join(', ') || '(none)'}`
    )
    return {
      updated: true,
      newVersions: [...remoteKeys].filter((v) => !currentKeys.has(v)).sort(sortDesc),
      removedVersions: [...currentKeys].filter((v) => !remoteKeys.has(v)).sort(sortDesc)
    }
  })

  ipcMain.handle('runtime:resetConfig', (): void => {
    // Deletes the data/runtime.json override (no-op when absent) so the
    // bundled configurations/runtime.json becomes active again. Never
    // touches the .bak backups.
    resetRuntimeConfig()
  })

  // ---------- hub ----------
  ipcMain.handle('hub:catalog', (): HubCatalog | null => hub.get())

  ipcMain.handle('hub:refresh', async (): Promise<HubCatalog> => {
    return hub.refresh((msg) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('hub:progress', { message: msg })
      }
    })
  })

  ipcMain.handle('hub:checkUpdates', async (): Promise<HubCheckResult> => {
    const url = HUB_CONFIG_URL
    console.log(`[hub:checkUpdates] Fetching hub config from: ${url}`)

    // Detect a corrupt override *before* fetching: loadHubConfig() falls back
    // silently to the bundled config on parse/shape failure, so it alone
    // cannot surface the problem. On corruption nothing is fetched and no
    // files are touched.
    const override = readHubOverride()
    if (override.status === 'corrupt') {
      console.error('[hub:checkUpdates] Current hub config is corrupted')
      throw new Error(
        'Current hub config is corrupted â€” click Reset in Settings â†’ Models (or restore a .bak) and retry'
      )
    }

    let remoteRaw: string
    try {
      remoteRaw = await fetchText(url)
    } catch (e) {
      console.error('[hub:checkUpdates] Fetch failed:', e)
      throw new Error(`Failed to fetch hub config from ${url}: ${(e as Error).message}`)
    }

    let remote: HubConfig
    try {
      remote = JSON.parse(remoteRaw) as HubConfig
    } catch (e) {
      console.error('[hub:checkUpdates] Remote hub config is not valid JSON:', e)
      throw new Error(`Remote hub config is not valid JSON: ${(e as Error).message}`)
    }
    const problem = validateHubConfig(remote)
    if (problem) {
      console.error('[hub:checkUpdates] Remote hub config is invalid:', problem)
      throw new Error(`Remote hub config is invalid: ${problem}`)
    }

    // The existing override was already validated by readHubOverride() above,
    // so loadHubConfig() *is* the effective config here (valid override, else
    // bundled). Compare key-order-stable: a key reorder with identical
    // content is NOT an update.
    const current = loadHubConfig()
    if (stableStringify(remote) === stableStringify(current)) {
      console.log('[hub:checkUpdates] Success: no update needed â€” hub config is up to date')
      return { updated: false, addedModels: [], removedModels: [] }
    }

    // Backs up the previous override (timestamped .bak) and writes atomically.
    saveHubConfig(remote)

    // Model-level diff over the diffusion entries the Models section lists.
    const remoteNames = new Set(remote.repo.diffusion.map((d) => d.name))
    const currentNames = new Set(current.repo.diffusion.map((d) => d.name))
    const addedModels = [...remoteNames].filter((n) => !currentNames.has(n)).sort()
    const removedModels = [...currentNames].filter((n) => !remoteNames.has(n)).sort()
    console.log(
      `[hub:checkUpdates] Success: hub config updated â€” new: ${addedModels.join(', ') || '(none)'}; removed: ${removedModels.join(', ') || '(none)'}`
    )
    return { updated: true, addedModels, removedModels }
  })

  ipcMain.handle('hub:resetConfig', (): void => {
    // Deletes the data/hub.json override (no-op when absent) so the bundled
    // configurations/hub.json becomes active again. Never touches the .bak
    // backups.
    resetHubConfig()
  })

  // ---------- models ----------
  ipcMain.handle('models:list', (_e, type: ModelType): ModelFile[] => models.list(type))

  ipcMain.handle(
    'models:download',
    async (_e, type: ModelType, url: string, provider?: string, force?: boolean): Promise<string> => {
      // The download manager is the sole source of `models:progress`; the
      // handler just awaits it. The resolved destination path is still
      // returned (Promise<string> contract preserved) even though no current
      // renderer caller consumes it â€” a future refactor could change this.
      //
      // Pause/Cancel aborts the download on purpose, rejecting the in-flight
      // promise with DownloadAbortError. Electron logs every handler
      // rejection as "Error occurred in handler", so an expected abort must
      // not escape as a rejection: resolve the '' sentinel instead (no real
      // destination path is ever empty). The settings store translates ''
      // back into the DOWNLOAD_ABORTED_MESSAGE error for awaiters.
      try {
        return await models.download(type, url, () => {}, provider, force)
      } catch (err) {
        if (isDownloadAbortError(err)) return ''
        throw err
      }
    }
  )

  ipcMain.handle('models:remove', (_e, type: ModelType, name: string): void => {
    models.remove(type, name)
  })

  /**
   * Verify an installed model file's size against the server's content-length.
   * `expected` is 0 when the HEAD request fails (offline); in that case the
   * file is assumed fine (`ok: true`).
   */
  ipcMain.handle(
    'models:verify',
    async (
      _e,
      type: ModelType,
      name: string,
      url: string
    ): Promise<{ ok: boolean; actual: number; expected: number }> => {
      const p = models.pathFor(type, name)
      const actual = existsSync(p) ? statSync(p).size : 0
      const expected = await headSize(url)
      return { ok: expected === 0 || actual === expected, actual, expected }
    }
  )

  // ---------- settings ----------
  ipcMain.handle('settings:get', (): Settings => settings.get())

  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>): Settings => settings.save(patch))

  // ---------- theme ----------
  // Persists the chosen theme and broadcasts it so every renderer window applies
  // it live. The renderer store's own setTheme() is a fast in-window path; this
  // handler is the cross-context bridge used by window.api.setTheme() from the
  // console or anywhere the store isn't reachable.
  ipcMain.handle('theme:set', (_e, key: ThemeKey): Settings => {
    const next = settings.save({ theme: key })
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:changed', key)
    }
    return next
  })

  // ---------- sessions ----------
  ipcMain.handle('sessions:list', (): Session[] => sessions.list())
  ipcMain.handle('sessions:get', (_e, id: string): Session | null => sessions.get(id))
  ipcMain.handle('sessions:create', (_e, name?: string): Session => sessions.create(name))
  ipcMain.handle('sessions:rename', (_e, id: string, name: string): Session => sessions.rename(id, name))
  ipcMain.handle('sessions:remove', (_e, id: string): void => sessions.remove(id))
  ipcMain.handle(
    'sessions:removeMessage',
    (_e, id: string, messageId: string): Session => sessions.removeMessage(id, messageId)
  )
  ipcMain.handle(
    'sessions:setInputs',
    (_e, id: string, patch: SessionInputs): Session => sessions.setInputs(id, patch)
  )

  // ---------- generation ----------
  ipcMain.handle('gen:start', async (_e, req: GenerationRequest): Promise<string> => {
    const cfg = loadAllConfigs()
    const sampling = effectiveSampling(req.diffusionType, cfg)
    // How the diffusion weights are passed: 'all_in_one' types ship a full
    // checkpoint (conditioners + VAE inside the file) and go out via `--model`;
    // 'standalone' types (default) go out via `--diffusion-model`.
    const modelBehavior = sampling.diffusion_behavior

    const st = settings.get()
    const version = st.runtimeVersion ?? Object.keys(cfg.runtime).sort((a, b) => Number(b) - Number(a))[0]
    const binary = runtime.binaryFor(version)
    if (!binary) {
      throw new Error(`Runtime ${version} is not installed. Download it in Settings â†’ Runtime.`)
    }

    const modelPath = models.pathFor('diffusion', req.model)
    if (!existsSync(modelPath)) throw new Error(`Diffusion model not found: ${req.model}`)
    const vaePath = req.vae ? models.pathFor('vae', req.vae, req.vaeProvider) : undefined
    if (req.vae && vaePath && !existsSync(vaePath)) throw new Error(`VAE not found: ${req.vae}`)
    const encoderPath = req.encoder ? models.pathFor('encoder', req.encoder, req.encoderProvider) : undefined
    if (req.encoder && encoderPath && !existsSync(encoderPath)) {
      throw new Error(`Encoder not found: ${req.encoder}`)
    }
    // Encoder bundle (SD3.5-style multi-encoder): resolve every file. The
    // bundle and the single-file encoder are mutually exclusive by
    // construction; the guard below makes a malformed request unable to emit
    // both `--llm` and bundle flags (mirrored inside buildArgs()).
    const encoderRefs: { path: string; useAs: string }[] = []
    if (req.encoders && req.encoders.length > 0) {
      for (const enc of req.encoders) {
        const p = models.pathFor('encoder', enc.name)
        if (!existsSync(p)) throw new Error(`Encoder not found: ${enc.name}`)
        encoderRefs.push({ path: p, useAs: enc.useAs })
      }
    }
    const visionPath = req.vision ? models.pathFor('vision', req.vision) : undefined
    if (req.vision && visionPath && !existsSync(visionPath)) {
      throw new Error(`Vision model not found: ${req.vision}`)
    }

    const refs = [...req.referencePaths]
    if (
      req.usePrevious &&
      sampling.allow_reference === true &&
      req.previousImagePath &&
      existsSync(req.previousImagePath)
    ) {
      if (!refs.includes(req.previousImagePath)) refs.push(req.previousImagePath)
    }
    if (refs.length > sampling.max_reference) refs.length = sampling.max_reference

    // img2img: when the diffusion type declares img2img support (and allows
    // references at all) and the user ticked 'Use previous image', the
    // referenced image is reinterpreted as the init image and passed via
    // `--init-img` (-i) instead of `--ref-image` (-r). `--init-img` accepts a
    // single path, so the first existing reference becomes the init image and
    // any leftovers stay references (max_reference is 1 for every
    // img2img-enabled type today, so in practice no `-r` is emitted).
    const useInitImg =
      sampling.img2img === true &&
      sampling.allow_reference === true &&
      req.usePrevious === true
    const existingRefs = refs.filter((r) => existsSync(r))
    const initImage = useInitImg ? existingRefs.shift() : undefined

    const session = sessions.get(req.sessionId)
    if (!session) throw new Error(`Session ${req.sessionId} not found`)

    // Session-level sampling override (5 whitelisted fields) wins over the
    // global effective sampling. Main consumes from `sampling` only
    // diffusion_behavior / allow_reference / max_reference / img2img â€” none
    // session-overridable. steps/cfg/strength/sampler already arrive merged in
    // `req` from the renderer, so this is defense-in-depth; what main actually
    // needs is the scheduler/negative fallbacks resolved below. Width/height
    // are no longer session-overridable â€” the resolution selected in the chat
    // panel always wins.
    const sessSampling = session.inputs?.sampling
    if (sessSampling) {
      if (sessSampling.steps !== undefined) sampling.steps = sessSampling.steps
      if (sessSampling.cfg !== undefined) sampling.cfg = sessSampling.cfg
      if (sessSampling.strength !== undefined) sampling.strength = sessSampling.strength
      if (sessSampling.sampler !== undefined) sampling.sampler = sessSampling.sampler
      if (sessSampling.scheduler !== undefined) sampling.scheduler = sessSampling.scheduler
    }
    // Negative prompt: request value (sent by renderer) wins; else the session
    // file's saved value (defense-in-depth); else the global per-type default.
    const negative =
      (req.negativePrompt ?? session.inputs?.negativePrompt ?? '').trim() ||
      (sampling.negative ?? '').trim()
    if (negative) req.negativePrompt = negative
    // Scheduler: `req.scheduler` carries the RAW renderer value (a concrete
    // string, the 'model-specific' sentinel, or undefined). Resolve the
    // sentinel and the global fallback here in one place. A concrete value
    // survives; a sentinel vanishes WITHOUT triggering the global fallback;
    // only an absent value falls back to the global default.
    const raw = req.scheduler ?? sampling.scheduler
    req.scheduler = raw && raw !== SCHEDULER_MODEL_DEFAULT && String(raw).trim() ? String(raw).trim() : undefined

    const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const userMsg: ChatMessage = {
      id: messageId,
      role: 'user',
      text: req.prompt,
      refs: refs.map((r) => r),
      createdAt: Date.now()
    }
    sessions.addMessage(req.sessionId, userMsg)
    const assistantMsg: ChatMessage = {
      id: messageId + '-a',
      role: 'assistant',
      text: '',
      status: 'ok',
      createdAt: Date.now()
    }
    sessions.addMessage(req.sessionId, assistantMsg)

    const output = newOutputPath(req.sessionId, assistantMsg.id)
    const paths = {
      model: modelPath,
      modelBehavior,
      vae: vaePath,
      // Bundle wins: when `encoders` resolved non-empty, `encoder` is ignored.
      encoder: encoderRefs.length ? undefined : encoderPath,
      encoders: encoderRefs.length ? encoderRefs : undefined,
      vision: visionPath,
      initImage,
      references: existingRefs,
      output
    }

    // Apply the global performance settings (Flash Attention, VAE tiling,
    // CPU offload, params backend, ...) to this generation, but only when the
    // user has explicitly enabled the performance profile in settings.json.
    const perf = settings.get().performance
    if (perf?.enabled) req.performance = perf

    const gen = sdcli.generate(binary, req, paths, {
      onProgress: (step, totalSteps) =>
        sendProgress(req.sessionId, assistantMsg.id, { status: 'running', step, totalSteps }),
      onDone: (imagePath) => {
        activeGens.delete(req.sessionId)
        sessions.updateMessage(req.sessionId, assistantMsg.id, {
          image: { path: imagePath, name: basename(imagePath) },
          status: 'ok'
        })
        sendProgress(req.sessionId, assistantMsg.id, {
          status: 'done',
          image: { path: imagePath, name: basename(imagePath) }
        })
      },
      onError: (message) => {
        activeGens.delete(req.sessionId)
        sessions.updateMessage(req.sessionId, assistantMsg.id, { status: 'error', error: message })
        sendProgress(req.sessionId, assistantMsg.id, { status: 'error', error: message })
      }
    })

    activeGens.set(req.sessionId, { gen, sessionId: req.sessionId, messageId: assistantMsg.id })
    return assistantMsg.id
  })

  ipcMain.handle('gen:stop', (_e, sessionId: string): void => {
    const entry = activeGens.get(sessionId)
    if (!entry) return
    sdcli.stop(entry.gen)
    sessions.updateMessage(entry.sessionId, entry.messageId, { status: 'stopped' })
    sendProgress(entry.sessionId, entry.messageId, { status: 'stopped' })
    activeGens.delete(sessionId)
  })

  ipcMain.handle('gen:isRunning', (_e, sessionId: string): boolean => activeGens.has(sessionId))

  // ---------- logs ----------
  /** Serve at most the last 1 MB of latest.log (Settings â†’ Logs). */
  const LOG_TAIL_BYTES = 1024 * 1024
  /** Cap each forwarded renderer message so a runaway loop can't bloat the log. */
  const LOG_FORWARD_MAX_CHARS = 64 * 1024

  ipcMain.handle('logs:get', async (): Promise<LogsInfo> => {
    try {
      const fh = await fsOpen(join(dataRoot(), 'logs', 'latest.log'), 'r')
      try {
        const size = (await fh.stat()).size
        if (size === 0) return { content: '', size: 0 }
        // Read only the last â‰¤1 MB (open, stat, read from max(0, size - 1MB))
        // rather than reading the whole file and truncating.
        const start = Math.max(0, size - LOG_TAIL_BYTES)
        const length = size - start
        const buf = Buffer.alloc(length)
        await fh.read(buf, 0, length, start)
        // When truncated, drop leading bytes until a UTF-8 lead byte so a
        // multi-byte character split at the cut point doesn't render as
        // replacement characters (continuation bytes are 0b10xxxxxx).
        let offset = 0
        if (start > 0) {
          while (offset < length && (buf[offset] & 0xc0) === 0x80) offset++
        }
        return { content: new TextDecoder().decode(buf.subarray(offset)), size }
      } finally {
        await fh.close()
      }
    } catch (e) {
      // Fresh install: the file may not exist yet â€” return empty instead of
      // rejecting (Electron logs every handler rejection as "Error occurred
      // in handler").
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', size: 0 }
      throw e
    }
  })

  // Renderer console bridge (installed in src/renderer/src/main.ts). `on`,
  // not `handle` â€” nothing to reply to, and per-call request/response overhead
  // is unnecessary for chatty renderer output.
  ipcMain.on('logs:forward', (_e, level: LogLevel, args: unknown[]): void => {
    try {
      // Whitelist the level so a compromised renderer can't invoke arbitrary
      // properties on the logger; unknown values are dropped.
      if (level !== 'log' && level !== 'info' && level !== 'warn' && level !== 'error' && level !== 'debug') {
        return
      }
      const fn =
        level === 'error'
          ? log.error
          : level === 'warn'
            ? log.warn
            : level === 'debug'
              ? log.debug
              : log.info // 'log' and 'info' both map to info
      const list = Array.isArray(args) ? args : [args]
      const text = list.map((a) => stringifyArg(a)).join(' ')
      const line =
        text.length > LOG_FORWARD_MAX_CHARS
          ? `${text.slice(0, LOG_FORWARD_MAX_CHARS)}â€¦(truncated)`
          : text
      // [renderer] prefix keeps forwarded lines distinguishable from
      // main-process lines in the mixed latest.log.
      fn(`[renderer] ${line}`)
    } catch {
      // Logging must never throw into main (disk full, file locked) â€” drop.
    }
  })
}

import { dataRoot } from './services/data'

export function initDataDirs(): void {
  const root = dataRoot()
  for (const d of [
    'models/diffusion',
    'models/encoder',
    'models/vae',
    'output',
    'sessions',
    'cache',
    'runtime',
    'logs'
  ]) {
    mkdirSync(join(root, d), { recursive: true })
  }
  // `data/tmp` holds staged downloads (models + runtime zips) before they are
  // moved to their live destination. Wiped as a full clean slate on every launch
  // so an interrupted download never leaves a partial file behind â€” a fresh full
  // re-download is always performed. The wipe happens before startAllPending()
  // (fired from index.ts after registerIpc()) so background retries start clean.
  mkdirSync(join(root, 'tmp'), { recursive: true })
  rmSync(join(root, 'tmp'), { recursive: true, force: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  ensureModelDirs()
}

