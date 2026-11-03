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
  ConfigUpdateStatus,
  DownloadProgress,
  GenProgress,
  GenerationRequest,
  HubCatalog,
  HubCheckResult,
  LogLevel,
  LogsInfo,
  LoraApplyMode,
  MaskSaveRequest,
  MaskSaveResult,
  ModelFile,
  ModelType,
  PlatformInfo,
  ResolutionEntry,
  RuntimeCheckResult,
  RuntimeKey,
  RuntimeVersionInfo,
  SamplingDefaults,
  Session,
  SessionInputs,
  Settings,
  ThemeKey,
  TokenEntry,
  TokenEntryInput,
  TokenEntryResult,
  TokenImportResult
} from '@shared/types'
import {
  loadAllConfigs,
  loadApplicationConfig,
  resetHubConfig,
  resetRuntimeConfig,
  saveHubConfig,
  saveRuntimeConfig
} from './services/config'
import { DownloadAbortError, headSize } from './services/download'
import { createHubService } from './services/hub'
import { getInitState } from './services/init'
import { authHeadersForUrl, createModelsService, ensureModelDirs } from './services/models'
import { detectPlatform } from './services/platform'
import { clearMask, saveMask } from './services/masks'
import { createRuntimeService } from './services/runtime'
import { createSessionsService } from './services/sessions'
import { createSettingsService } from './services/settings'
import { createSdCliService, newOutputPath } from './services/sdcli'
import { sourceNames } from './services/sources'
import { addToken, deleteToken, exportTokens, importTokens, listTokens, updateToken } from './services/tokens'
import { checkHubConfig, checkRuntimeConfig, getConfigUpdateStatus } from './services/updates'
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
import { SCHEDULER_MODEL_DEFAULT, isValidSeed } from '@shared/types'
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

/** Toast-friendly cap for a generation error line; the full text goes to the log. */
const GEN_ERROR_TOAST_MAX = 200

/**
 * Collapse a raw sd-cli failure into one short toast-friendly line: whitespace
 * (including newlines — stderr often arrives as a wall of repeated
 * tensor/loader warnings) collapsed, then hard-truncated. The untruncated
 * text is logged by the caller, so the toast is a pointer to the log, never
 * the record itself.
 */
function shortGenError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length <= GEN_ERROR_TOAST_MAX) return flat
  return flat.slice(0, GEN_ERROR_TOAST_MAX - 1).trimEnd() + '…'
}

/**
 * A saved inpaint/outpaint mask rides on every Send as `maskPath` +
 * `initImagePath` — but the renderer's sticky maskState is paths-only and the
 * mask files live under the ephemeral `data/tmp/masks` tree (wiped on every
 * launch), so a session can carry dead references. Purge: delete the saved
 * mask files (clearMask only ever touches data/tmp/masks — the inpaint
 * background may live outside it and is left alone), push `masks:invalidated`
 * so the renderer drops its sticky state, show a warning dialog, and reject
 * the generation with a re-apply instruction. The renderer suppresses the
 * duplicate error toast for this message (it matches on 'purged').
 */
async function purgeStaleMask(
  req: GenerationRequest,
  missing: 'mask' | 'background'
): Promise<never> {
  const paths = [req.maskPath, req.initImagePath].filter((p): p is string => !!p)
  clearMask(paths)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('masks:invalidated', { sessionId: req.sessionId })
  }
  log.warn(
    `[gen] stale inpaint/outpaint reference (session ${req.sessionId}): ` +
      `${missing === 'mask' ? 'mask file' : 'mask background'} no longer exists — purged`
  )
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Mask reference removed',
    message: 'A referenced image used for inpainting/outpainting has been removed.',
    detail:
      'The application has purged the stale reference (the saved mask and its background). ' +
      'Please re-apply the mask and execute the generation again.',
    buttons: ['OK']
  })
  throw new Error(
    missing === 'mask'
      ? 'The saved mask no longer exists — the stale reference has been purged. Please re-apply the mask and execute the generation again.'
      : 'The mask background no longer exists — the stale reference has been purged. Please re-apply the mask and execute the generation again.'
  )
}

/**
 * A saved paint rides on every Send as `paintImagePath` — same ephemeral
 * data/tmp/masks lifecycle as the mask files, so a file deleted externally
 * mid-session leaves the renderer's sticky paintState pointing at nothing.
 * Purge: delete the saved paint file, push `masks:invalidated` so the renderer
 * drops its sticky state (the handler clears BOTH the mask and paint states),
 * show a warning dialog, and reject the generation — the paint must be
 * re-applied. The renderer suppresses the duplicate error toast for the
 * 'purged' message, same as the mask purge.
 */
async function purgeStalePaint(req: GenerationRequest): Promise<never> {
  if (req.paintImagePath) clearMask([req.paintImagePath])
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('masks:invalidated', { sessionId: req.sessionId })
  }
  log.warn(
    `[gen] stale paint reference (session ${req.sessionId}): ` +
      `painted image no longer exists — purged`
  )
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Paint reference removed',
    message: 'A painted image used for this generation has been removed.',
    detail:
      'The application has purged the stale reference (the saved painted image). ' +
      'Please re-apply the paint and execute the generation again.',
    buttons: ['OK']
  })
  throw new Error(
    'The painted image no longer exists — the stale reference has been purged. Please re-apply the paint and execute the generation again.'
  )
}

function effectiveSampling(diffusionType: string, cfg: AllConfigs): SamplingDefaults {
  const base = cfg.sampling[diffusionType] ?? {
  diffusion_behavior: 'standalone',
  allow_reference: false,
  max_reference: 0,
  allow_image_input: false,
  max_image_input: 0,
  allow_inpainting: false,
  allow_painting: false,
    strength: 0.75,
    steps: 25,
    cfg: 1.0,
    sampler: 'euler',
    scheduler: null,
    negative: null,
    flow_shift: null,
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

  // Native directory picker (the LoRA dialog's custom-dir Browse button;
  // generic name so future features can reuse it). Resolves null when
  // canceled — never an error.
  ipcMain.handle('app:pickDirectory', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose LoRA directory',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // ---------- masks (data/tmp/masks — inpaint / outpaint) ----------
  // Persist the renderer's painted mask (and the padded init image for
  // outpaint) as PNG files under data/tmp/masks; the returned absolute paths
  // ride on the sticky composer state and the gen:start request.
  ipcMain.handle('masks:save', (_e, req: MaskSaveRequest): MaskSaveResult => saveMask(req))
  // Delete saved mask / init files. clearMask() restricts deletion to
  // data/tmp/masks — the renderer controls the paths, so nothing outside that
  // directory can ever be removed.
  ipcMain.handle('masks:clear', (_e, paths: string[]): void => clearMask(paths))

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
    // Fetch + validate + key-order-stable compare live in the shared helper
    // (also used by the launch-time update check); this handler adds the
    // apply step: back up + write the override, then diff the version keys.
    const { changed, remote, current } = await checkRuntimeConfig()
    if (!changed) {
      console.log(
        `[runtime:checkUpdates] Success: no update needed — runtime config is up to date`
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
    // Fetch + validate + key-order-stable compare live in the shared helper
    // (also used by the launch-time update check); this handler adds the
    // apply step: back up + write the override, then diff the model names.
    const { changed, remote, current } = await checkHubConfig()
    if (!changed) {
      console.log('[hub:checkUpdates] Success: no update needed — hub config is up to date')
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

  // ---------- updates ----------
  // Result of the launch-time config update check (detect-only; the check
  // itself is fired from index.ts at the end of the init pipeline and its
  // notify callback broadcasts updates:available). The renderer pulls this on
  // mount to catch up when the check completed before it mounted — the same
  // pattern as app:initState. null until the first check of the session
  // completes.
  ipcMain.handle('updates:get', (): ConfigUpdateStatus | null => getConfigUpdateStatus())

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
      // Authenticated probe: the models:verify HEAD runs OUTSIDE the download
      // manager, so the manager's two header threads never reach it. Without
      // headers a private repo's HEAD answers 401 → expected === 0 → the
      // `expected === 0 || actual === expected` fallback below reports
      // ok: true with zero verification (a truncated private file always
      // passes). authHeadersForUrl yields {} when no source/token — the
      // pre-existing anonymous semantics.
      const expected = await headSize(url, undefined, undefined, await authHeadersForUrl(url))
      return { ok: expected === 0 || actual === expected, actual, expected }
    }
  )

  // ---------- tokens / sources ----------
  // Token management for data/hub-tokens.json (Settings → Tokens). Import/
  // Export do their file-dialog I/O entirely in main — the renderer has no
  // arbitrary-file read/write IPC (the existing dialog IPCs are
  // image-specific). Raw token values reach the renderer only through the
  // add/edit input field (unavoidable) — never via the list (masked) and
  // never via export (written to disk here, in the live store format).
  ipcMain.handle('tokens:list', (): TokenEntry[] => listTokens())
  ipcMain.handle('tokens:add', (_e, input: TokenEntryInput): TokenEntryResult => addToken(input))
  ipcMain.handle('tokens:update', (_e, key: string, token: string): TokenEntryResult =>
    updateToken(key, token)
  )
  ipcMain.handle('tokens:delete', (_e, key: string): void => deleteToken(key))
  ipcMain.handle('tokens:importFile', async (): Promise<TokenImportResult | null> => {
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'Import Tokens',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null // canceled ≠ error
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(res.filePaths[0], 'utf-8'))
    } catch (err) {
      throw new Error(`Could not read ${basename(res.filePaths[0])}: ${(err as Error).message}`)
    }
    return importTokens(raw)
  })
  ipcMain.handle('tokens:exportFile', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      title: 'Export Tokens',
      defaultPath: 'hub-tokens.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      buttonLabel: 'Export'
    })
    if (res.canceled || res.filePath === '') return null
    // Written in the LIVE store format ({ key: { token } }) — a valid
    // drop-in backup: hand-copying it back over data/hub-tokens.json
    // restores exactly that state. Never sent to the renderer.
    const fs = await import('node:fs')
    await fs.promises.writeFile(res.filePath, JSON.stringify(exportTokens(), null, 2), 'utf-8')
    return res.filePath
  })
  // Registered source NAMES (deduped — the registry is keyed by both domains
  // and names) for the add/edit dialog source dropdown.
  ipcMain.handle('sources:list', (): string[] => sourceNames())

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
    const tokenizerPath = req.tokenizer ? models.pathFor('tokenizer', req.tokenizer) : undefined
    if (req.tokenizer && tokenizerPath && !existsSync(tokenizerPath)) {
      throw new Error(`Tokenizer not found: ${req.tokenizer}`)
    }

    // ---------- two-channel routing ----------
    // Reference channel (--ref-image): user-picked references plus the
    // previous image when chained "As Reference". Defense-in-depth: a
    // request's referencePaths are dropped for a type that forbids them.
    const prevExists = !!req.previousImagePath && existsSync(req.previousImagePath)
    const refs: string[] = sampling.allow_reference === true ? [...req.referencePaths] : []
    if (
      req.usePrevious &&
      req.previousImageMode === 'reference' &&
      sampling.allow_reference === true &&
      prevExists
    ) {
      if (!refs.includes(req.previousImagePath!)) refs.push(req.previousImagePath!)
    }
    if (refs.length > sampling.max_reference) refs.length = sampling.max_reference

    // Input channel (--init-img): user-picked input images plus the previous
    // image when chained "As input". --init-img is single-valued, so only the
    // first valid path survives; the previous image takes the slot ahead of
    // any user-picked inputs (first valid wins). Defense-in-depth: the
    // channel is dropped entirely for a type that forbids it.
    const inputImages: string[] =
      sampling.allow_image_input === true ? [...(req.inputImagePaths ?? [])] : []
    if (
      req.usePrevious &&
      req.previousImageMode === 'input' &&
      sampling.allow_image_input === true &&
      prevExists
    ) {
      inputImages.unshift(req.previousImagePath!)
    }
    if (inputImages.length > sampling.max_image_input) {
      inputImages.length = sampling.max_image_input
    }
    const existingInputs = inputImages.filter((r) => existsSync(r)).slice(0, 1)

    const existingRefs = refs.filter((r) => existsSync(r))
    let initImage: string | undefined
    let maskPath: string | undefined
    // Inpainting / outpainting: when the request carries an explicit mask +
    // init image (both saved by the dialogs and captured at dialog time), the
    // gate is `allow_inpainting` — NOT the reference/input channels. The
    // explicit init image wins over the previous-image init chaining and is
    // dropped from the refs so it is never double-emitted as --ref-image.
    // When the gate is off the fields are dropped entirely (defense-in-depth,
    // same style as the channel guards): a stale request can never emit mask
    // flags for a type that forbids them.
    if (req.maskPath && req.initImagePath) {
      if (sampling.allow_inpainting === true) {
        // Stale reference (data/tmp/masks is wiped on launch): purge the saved
        // files, drop the renderer's sticky mask state, inform the user, and
        // reject the generation — the mask must be re-applied.
        if (!existsSync(req.maskPath)) await purgeStaleMask(req, 'mask')
        if (!existsSync(req.initImagePath)) await purgeStaleMask(req, 'background')
        maskPath = req.maskPath
        initImage = req.initImagePath
        const i = existingRefs.indexOf(req.initImagePath)
        if (i >= 0) existingRefs.splice(i, 1)
      } else {
        req.maskPath = undefined
        req.initImagePath = undefined
      }
    }
    // Paint tool gate (configurations/sampling.json `allow_painting`): when
    // off, the fields are dropped entirely (defense-in-depth, same style as
    // the mask/channel guards) — a stale request can never route a painted
    // image for a type that forbids the tool.
    if (req.paintImagePath && sampling.allow_painting !== true) {
      req.paintImagePath = undefined
      req.paintTarget = undefined
    }
    // Paint tool: when the request carries a merged painted image, route it by
    // the target decided at paint-save time. Mutually exclusive with the mask
    // by construction (the composer's switch-guard keeps one tool state at a
    // time); the guard here makes an impossible mask+paint combo unable to
    // emit both. The 'init' target wins the same precedence slot as the mask
    // background — over the previous-image chaining and user-picked inputs;
    // the 'reference' target replaces the FIRST --ref-image slot (or becomes
    // the only ref when the channel is empty). Defense-in-depth: the fields
    // are dropped for a type whose channel config forbids the target, and an
    // unrecognized target is treated as absent.
    const paintTarget =
      req.paintImagePath && (req.paintTarget === 'init' || req.paintTarget === 'reference')
        ? req.paintTarget
        : undefined
    if (req.paintImagePath && paintTarget && !(maskPath && initImage)) {
      if (!existsSync(req.paintImagePath)) await purgeStalePaint(req)
      if (paintTarget === 'init') {
        if (sampling.allow_image_input === true) {
          initImage = req.paintImagePath
          const k = existingInputs.indexOf(req.paintImagePath)
          if (k >= 0) existingInputs.splice(k, 1)
          const r = existingRefs.indexOf(req.paintImagePath)
          if (r >= 0) existingRefs.splice(r, 1)
        } else {
          req.paintImagePath = undefined
          req.paintTarget = undefined
        }
      } else {
        if (sampling.allow_reference === true) {
          // Remove any duplicate occurrence first, then take slot 0 — or
          // become the only ref when the channel is empty (guarded against a
          // degenerate allow_reference + max_reference 0 config).
          const dup = existingRefs.indexOf(req.paintImagePath)
          if (dup >= 0) existingRefs.splice(dup, 1)
          if (existingRefs.length > 0) existingRefs[0] = req.paintImagePath
          else if (sampling.max_reference > 0) existingRefs.push(req.paintImagePath)
        } else {
          req.paintImagePath = undefined
          req.paintTarget = undefined
        }
      }
    }
    // Init image precedence: the mask background wins, then the previous
    // image chained "As input", then the first user-picked input image.
    // When the mask background is also an input image it is removed from the
    // input slot — initImage already carries it and --init-img is
    // single-valued.
    if (!initImage) initImage = existingInputs[0]
    if (initImage) {
      const j = existingInputs.indexOf(initImage)
      if (j >= 0) existingInputs.splice(j, 1)
    }

    const session = sessions.get(req.sessionId)
    if (!session) throw new Error(`Session ${req.sessionId} not found`)

    // Session-level sampling override (6 whitelisted fields) wins over the
    // global effective sampling. Main consumes from `sampling` only
    // diffusion_behavior / allow_reference / max_reference / allow_image_input
    // â€” none session-overridable. steps/cfg/strength/sampler already arrive
    // merged in
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
      if (sessSampling.flow_shift !== undefined) sampling.flow_shift = sessSampling.flow_shift
      // `!== undefined` (not a truthiness check): an explicit null must
      // overwrite a previously saved fixed seed.
      if (sessSampling.seed !== undefined) sampling.seed = sessSampling.seed
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
    // Flow shift: `req.flowShift` carries the RAW renderer value (a finite
    // number, '', null, or undefined). Request value wins; else the global
    // effective default. A finite number (incl 0) or a numeric string
    // survives; '' / null / undefined / non-numeric => undefined => buildArgs
    // emits no --flow-shift flag (sd-cli default: auto).
    const rawFlow = req.flowShift ?? sampling.flow_shift
    req.flowShift =
      typeof rawFlow === 'number' && Number.isFinite(rawFlow)
        ? rawFlow
        : typeof rawFlow === 'string' && rawFlow.trim() !== '' && Number.isFinite(Number(rawFlow))
          ? Number(rawFlow)
          : undefined
    // Seed: `req.seed` carries the RAW merged value (a finite integer in
    // [0, SEED_MAX], null, or undefined). Request value wins; else the
    // session-saved override (defense-in-depth). A valid integer survives as
    // a fixed seed; anything else => undefined => buildArgs generates a fresh
    // random seed per run.
    const rawSeed = req.seed ?? sampling.seed
    req.seed = isValidSeed(rawSeed) ? Math.floor(rawSeed) : undefined

    // LoRA: the per-session config lives in session.inputs.lora (the renderer
    // never sends it on the request — main is the source of truth at spawn
    // time, same as the negative-prompt fallback above). mode 'off' (or no
    // saved config) emits NEITHER flag. A custom dir that no longer exists on
    // disk silently falls back to the default store — the dialog's Clear
    // button is the supported way to remove the override. The default store
    // is data/models/lora (LoRAs nest per provider under it, like the other
    // model types).
    let loraSpawn: { dir: string; mode: Exclude<LoraApplyMode, 'off'> } | undefined
    const loraCfg = session.inputs?.lora
    if (loraCfg && loraCfg.mode !== 'off') {
      const dir =
        loraCfg.dir && existsSync(loraCfg.dir) ? loraCfg.dir : join(dataRoot(), 'models', 'lora')
      // The default dir is created by initDataDirs(); mkdir here is cheap
      // idempotence that also covers a freshly-picked custom dir.
      mkdirSync(dir, { recursive: true })
      loraSpawn = { dir, mode: loraCfg.mode }
    }

    const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const userMsg: ChatMessage = {
      id: messageId,
      role: 'user',
      text: req.prompt,
      // display-only: both channels land in the persisted user message
      refs: [...refs, ...inputImages],
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
      tokenizer: tokenizerPath,
      // Per-session LoRA flags; undefined when the session's mode is 'off'
      // (or unset) — buildArgs emits neither flag then.
      lora: loraSpawn,
      initImage,
      // inpaint/outpaint mask — always set together with initImage (main
      // never emits --mask without --init-img)
      mask: maskPath,
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
        // Errors live in the log (full detail) and as a toast (short line via
        // gen:progress); the chat message carries only the generic failure
        // status — raw sd-cli output never lands in the chat response.
        log.error(`[gen] generation failed (session ${req.sessionId}): ${message}`)
        activeGens.delete(req.sessionId)
        sessions.updateMessage(req.sessionId, assistantMsg.id, { status: 'error' })
        sendProgress(req.sessionId, assistantMsg.id, {
          status: 'error',
          error: shortGenError(message) || 'Generation failed'
        })
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
    'models/lora',
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

