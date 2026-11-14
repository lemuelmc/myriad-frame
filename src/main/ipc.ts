﻿/**
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
  CompanionKind,
  CompanionRef,
  ConfigUpdateStatus,
  DownloadProgress,
  GenProgress,
  GenerationRequest,
  GenStateInfo,
  UpscaleRequest,
  UpscaleResult,
  HubCatalog,
  HubCheckResult,
  HubConfig,
  LlmEnhanceResult,
  LlmStatusInfo,
  LogLevel,
  LogsInfo,
  LoraApplyMode,
  MaskSaveRequest,
  MaskSaveResult,
  ModelFile,
  ResizeSaveRequest,
  ResizeSaveResult,
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
  loadHubConfig,
  resetHubConfig,
  resetRuntimeConfig,
  saveHubConfig,
  saveRuntimeConfig
} from './services/config'
import { DownloadAbortError, headSize } from './services/download'
import {
  catalogEntriesForLocation,
  catalogHighNoiseCompanion,
  companionTargetsFor,
  createHubService
} from './services/hub'
import { getInitState } from './services/init'
import { authHeadersForUrl, createModelsService, ensureModelDirs } from './services/models'
import { detectPlatform } from './services/platform'
import { clearMask, saveMask } from './services/masks'
import { saveResized } from './services/resize'
import { createRuntimeService } from './services/runtime'
import { createSessionsService } from './services/sessions'
import { createSettingsService } from './services/settings'
import { convertToMp4, ensureFfmpeg } from './services/ffmpeg'
import { defaultModelInstalled, enhancePrompt, stopActiveEnhance } from './services/llm'
import { ensureLlmRuntime, llmStatus } from './services/llm-runtime'
import { isStreamableVideo, mediaUrlFor } from './services/media'
import { buildArgs, createSdCliService, newOutputPath } from './services/sdcli'
import { normalizeTileSize, runUpscale, upscaleOutputPath } from './services/upscaler'
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
import {
  COMPANION_USE_AS_DEFAULTS,
  FALLBACK_SAMPLING,
  SCHEDULER_MODEL_DEFAULT,
  applySamplingOverrides,
  isValidSeed
} from '@shared/types'
import type { DownloadsListResult } from '@shared/types'

const hub = createHubService()
const models = createModelsService()
const settings = createSettingsService()
const sessions = createSessionsService()
const runtime = createRuntimeService()
const sdcli = createSdCliService()

/** in-flight generations: sessionId -> { gen, sessionId, messageId, converting? } */
const activeGens = new Map<
  string,
  {
    gen: { child: import('node:child_process').ChildProcess; stopped: boolean }
    sessionId: string
    messageId: string
    /** true while the post-generation .avi → .mp4 conversion runs */
    converting?: boolean
  }
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
  // The configured entry (when the type HAS one) is merged OVER the shared
  // fallback — completing any descriptor key the entry predates (e.g.
  // boogu_image lacks `control_video`): gen:start reads every descriptor
  // UNGUARDED (`sampling.X.show`), so the effective descriptor must always
  // carry every key. Shallow spread: each present key replaces the
  // fallback's, missing keys inherit the closed-channel defaults.
  const configured = cfg.sampling[diffusionType]
  const base: SamplingDefaults = configured ? { ...FALLBACK_SAMPLING, ...configured } : FALLBACK_SAMPLING
  // Flat scalar overrides (settings.json per-type) merge into the descriptor
  // defaults — the same semantics as the renderer's `samplingFor()` (shared
  // `applySamplingOverrides` helper).
  return applySamplingOverrides(base, settings.get().sampling?.[diffusionType])
}

/**
 * The companion references for a diffusion type + kind — one { from, useAs }
 * per companion file, resolved from the hub entry's `requires.<kind>` block
 * (scalar → single item under the kind's default flag; array → one item per
 * entry). NEVER empty: when the hub entry declares no `requires.<kind>` — or
 * no `repo.diffusion` entry matches — the FALLBACK `[{ from: diffusionType,
 * useAs: <kind default> }]` is returned, so every caller can use
 * `comps[0].from` directly (the session's own diffusionType — exactly what
 * the old `requiresFamilyFor` returned). First `repo.diffusion` entry with
 * the requested family wins (`requires` is per hub ENTRY; each wan family
 * maps to exactly one entry). The hub config is PASSED IN by gen:start (the
 * handler already holds `cfg.hub` from its top-of-handler loadAllConfigs()
 * call — no extra per-kind loadHubConfig() reads).
 */
function requiresCompanionsFor(
  hub: HubConfig,
  diffusionType: string,
  kind: CompanionKind,
  hubName?: string
): CompanionRef[] {
  // A family may map to SEVERAL hub entries (multiple providers); the hub
  // entry `name` carried by the request pins the exact entry when present,
  // falling back to the first family match (the pre-hubName behavior).
  const entry =
    (hubName
      ? hub.repo.diffusion.find((d) => d.family === diffusionType && d.name === hubName)
      : undefined) ?? hub.repo.diffusion.find((d) => d.family === diffusionType)
  const raw = entry?.requires?.[kind]
  const fallback: CompanionRef[] = [{ from: diffusionType, useAs: COMPANION_USE_AS_DEFAULTS[kind] }]
  if (!raw) return fallback
  const items = (Array.isArray(raw) ? raw : [raw]) as { from?: unknown; use_as?: unknown }[]
  const out: CompanionRef[] = []
  for (const it of items) {
    if (it && typeof it === 'object' && typeof it.from === 'string' && it.from !== '') {
      out.push({
        from: it.from,
        useAs:
          typeof it.use_as === 'string' && it.use_as !== ''
            ? it.use_as
            : COMPANION_USE_AS_DEFAULTS[kind]
      })
    }
  }
  return out.length > 0 ? out : fallback
}

/**
 * One companion resolution site's outcome: the installed `{ path, useAs }`
 * pairs (deduped — a degenerate requires block resolving the SAME file emits
 * the flag once, not twice) and the items whose file is NOT on disk.
 */
interface CompanionResolution {
  resolved: { path: string; useAs: string }[]
  /** Companion items whose file is missing: the family, the flag, the name
   * the site tried to resolve ('' when nothing was derivable) and the
   * request's provider (feeds the exact-file re-download kick). */
  missing: { from: string; useAs: string; name: string; provider?: string }[]
}

/**
 * Resolve a companion array for gen:start. The companions array is NEVER
 * empty (requiresCompanionsFor's fallback), so an undeclared kind resolves
 * from the session's own diffusionType exactly as before. Name resolution:
 * the explicit request name (applied to every item — companion arrays are
 * single-item in practice for every kind but encoder) wins; otherwise the
 * item's OWN family's hub default is derived from the FRESH hub config (the
 * same stale-cache backstop the audio-VAE / latent-upscaler sites use). The
 * backstop only ever emits files that ALREADY exist on disk (the existsSync
 * guard) — a missing derived file lands in `missing` for the caller's
 * self-heal handling instead of being silently dropped.
 */
function resolveCompanionPaths(
  type: ModelType,
  companions: CompanionRef[],
  reqName?: string,
  reqProvider?: string,
  hubDefaultFor?: (family: string) => string
): CompanionResolution {
  const resolved: { path: string; useAs: string }[] = []
  const missing: CompanionResolution['missing'] = []
  for (const comp of companions) {
    const name = reqName ?? basename(hubDefaultFor?.(comp.from) ?? '')
    if (!name) {
      missing.push({ from: comp.from, useAs: comp.useAs, name: '' })
      continue
    }
    const p = models.pathFor(
      type,
      name,
      reqProvider,
      comp.from,
      expectUrlFor(type, comp.from, reqProvider, name)
    )
    if (existsSync(p)) {
      if (!resolved.some((o) => o.path === p)) resolved.push({ path: p, useAs: comp.useAs })
    } else {
      missing.push({
        from: comp.from,
        useAs: comp.useAs,
        name,
        ...(reqProvider !== undefined ? { provider: reqProvider } : {})
      })
    }
  }
  return { resolved, missing }
}

const COMPANION_KINDS: CompanionKind[] = [
  'vae',
  'encoder',
  'audio_encoder',
  'vision',
  'tokenizer',
  'audio_vae',
  'latent_upscaler'
]

const COMPANION_LABELS: Record<CompanionKind, string> = {
  vae: 'VAE',
  encoder: 'Text encoder',
  audio_encoder: 'Audio encoder',
  vision: 'Vision model',
  tokenizer: 'Tokenizer',
  audio_vae: 'Audio VAE',
  latent_upscaler: 'Latent upscaler'
}

/**
 * Whether the diffusion entry's `requires` block DECLARES the kind — distinct
 * from the fallback `requiresCompanionsFor` returns when it does not. The
 * gen:start self-heal only kicks downloads for DECLARED companions
 * (undeclared kinds keep today's silent-skip semantics).
 */
function requiresDeclaresFor(
  hub: HubConfig,
  diffusionType: string,
  kind: CompanionKind,
  hubName?: string
): boolean {
  const entry =
    (hubName
      ? hub.repo.diffusion.find((d) => d.family === diffusionType && d.name === hubName)
      : undefined) ?? hub.repo.diffusion.find((d) => d.family === diffusionType)
  const raw = entry?.requires?.[kind]
  if (!raw) return false
  const items = Array.isArray(raw) ? raw : [raw]
  return items.some(
    (it) =>
      !!it &&
      typeof it === 'object' &&
      typeof (it as { from?: unknown }).from === 'string' &&
      (it as { from: string }).from !== ''
  )
}

/**
 * Launch-time dependency self-heal (called from index.ts after
 * startAllPending): for EVERY session with a saved model, resolve its hub
 * entry's `requires` companions (the entry pinned by the saved `diffusionName`
 * when present, else the family) and kick a download for every declared
 * companion file that is not on disk. This is the launch-side resume path for
 * downloads that died WITHOUT leaving a registry entry — `startAllPending()`
 * already retries the ones that left one (pending/failed). Deduped by URL
 * across sessions and kinds; the manager's installed short-circuit skips
 * anything already complete. Presence probing goes through `pathFor` (with the
 * target's URL as the gate), so both the family-scoped and the legacy layouts
 * — and the same-URL cross-family copies — count as present. Never throws:
 * a launch-critical path must not break over a companion check.
 */
export function ensureSessionCompanionDownloads(): void {
  try {
    const hub = loadHubConfig()
    const pairs = new Map<string, { family: string; hubName?: string }>()
    for (const s of sessions.list()) {
      const inputs = s.inputs
      const family = inputs?.family ?? inputs?.diffusionType
      if (!inputs?.model || !family) continue
      const key = `${family}|${inputs.diffusionName ?? ''}`
      if (!pairs.has(key)) pairs.set(key, { family, hubName: inputs.diffusionName })
    }
    if (pairs.size === 0) return
    const seen = new Set<string>()
    let kicked = 0
    for (const { family, hubName } of pairs.values()) {
      for (const kind of COMPANION_KINDS) {
        if (!requiresDeclaresFor(hub, family, kind, hubName)) continue
        for (const comp of requiresCompanionsFor(hub, family, kind, hubName)) {
          for (const t of companionTargetsFor(kind, comp.from)) {
            if (seen.has(t.url)) continue
            seen.add(t.url)
            const p = models.pathFor(t.type, t.name, t.provider, comp.from, t.url)
            if (existsSync(p)) continue
            kicked++
            void models
              .download(t.type, t.url, () => {}, t.provider ?? 'default', false, comp.from)
              .catch((err: unknown) => {
                console.warn(
                  `[launch] companion download failed (${t.name}): ${(err as Error)?.message ?? String(err)}`
                )
              })
          }
        }
      }
    }
    if (kicked > 0) {
      console.log(
        `[launch] companion check: kicked ${kicked} download(s) for ${pairs.size} session model(s)`
      )
    }
  } catch (err) {
    console.warn('[launch] companion check failed:', (err as Error)?.message ?? String(err))
  }
}

/**
 * gen:start's `expectUrl` for one resolution site (model-collision-hardening
 * plan §3.6): pin the site's catalog entry from the cached catalog — the
 * entries at the site's exact location `(type, family, provider, basename)`
 * are the alternates set, and the first is as good as any; an absent
 * provider matches any-provider entries, mirroring the renderer's legacy
 * first-name-match fallback. Undefined when the catalog yields nothing
 * (wiped cache, renamed/deleted file) — pathFor then degrades permissively.
 */
function expectUrlFor(
  type: ModelType,
  diffusionType: string,
  provider: string | undefined,
  name: string
): string | undefined {
  return catalogEntriesForLocation(type, diffusionType, provider, name)[0]?.url
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

  // Parameterized media picker — the sampling.json channel `accepts` lists
  // drive the filters (e.g. `*.wav` for the S2V audio channel). The renderer
  // controls the filter list, so it is shape-sanitized here: only well-formed
  // { name, extensions } entries survive, extension values are dot-stripped
  // and lowercased.
  ipcMain.handle(
    'app:pickMedia',
    async (_e, filters: { name: string; extensions: string[] }[]): Promise<string[]> => {
      const list = (Array.isArray(filters) ? filters : []).filter(
        (f) => f && typeof f.name === 'string' && Array.isArray(f.extensions)
      )
      const safe = list.map((f) => ({
        name: f.name.slice(0, 64),
        extensions: f.extensions
          .filter((e) => typeof e === 'string' && e.trim() !== '')
          .map((e) => e.trim().replace(/^\*\./, '').replace(/^\./, '').toLowerCase())
          .slice(0, 16)
      }))
      const res = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: safe.length ? safe : [{ name: 'Files', extensions: ['*'] }]
      })
      return res.canceled ? [] : res.filePaths
    }
  )

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

  // ---------- resize / crop (data/tmp/resize — ResizeCropOverlay) ----------
  // Persist the renderer's cropped / resized image as a NEW PNG under
  // data/tmp/resize — the ORIGINAL picked file is never modified
  // (non-destructive by construction). The invoke rejects on a malformed
  // payload (wrong prefix / over the size cap); the overlay toasts the error.
  ipcMain.handle('resize:save', (_e, req: ResizeSaveRequest): ResizeSaveResult =>
    saveResized(req?.png)
  )

  ipcMain.handle('app:imageFromPath', (_e, p: string): string => {
    if (!existsSync(p)) return ''
    const ext = p.toLowerCase().split('.').pop() ?? 'png'
    // Streamable video containers (mp4/webm/mov) return an opaque media:// URL
    // instead of a data URL: Chromium's media stack cannot stream or seek from
    // a data URL (the player chrome renders but the controls stay dead), while
    // the privileged media:// protocol serves the bytes off disk with Range
    // support. Images and Motion-JPEG .avi keep the data-URL path — the .avi
    // poster extraction needs the raw bytes in the renderer.
    if (isStreamableVideo(p)) return mediaUrlFor(p)
    const buf = readFileSync(p)
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'bmp'
            ? 'image/bmp'
            : ext === 'avi'
              ? 'video/x-msvideo'
              : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('app:saveImage', async (_e, imagePath: string): Promise<string | null> => {
    if (!existsSync(imagePath)) return null
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    // vid_gen outputs are Motion-JPEG .avi containers — the save filter
    // follows the file (the other containers cover other runtime builds).
    const isVideo = /\.(mp4|avi|webm|mov)$/i.test(imagePath)
    const res = await dialog.showSaveDialog(win, {
      title: isVideo ? 'Save Video' : 'Save Image',
      defaultPath: basename(imagePath),
      filters: isVideo
        ? [{ name: 'Videos', extensions: ['mp4', 'avi', 'webm', 'mov'] }]
        : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
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

  // Open a file with the OS default application — the Motion-JPEG .avi
  // vid_gen outputs ride this (Chromium cannot demux AVI, so playback hands
  // off to the system player). Resolves false when the file is gone or no
  // application claimed it (the error detail lands in the log).
  ipcMain.handle('app:openPath', async (_e, p: string): Promise<boolean> => {
    if (!existsSync(p)) return false
    const err = await shell.openPath(p)
    if (err) {
      log.warn(`[app] openPath failed for ${p}: ${err}`)
      return false
    }
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

    const remoteKeys = new Set(Object.keys(remote.releases))
    const currentKeys = new Set(Object.keys(current.releases))
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
    async (
      _e,
      type: ModelType,
      url: string,
      provider?: string,
      force?: boolean,
      family?: string
    ): Promise<string> => {
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
        return await models.download(type, url, () => {}, provider, force, family)
      } catch (err) {
        if (isDownloadAbortError(err)) return ''
        throw err
      }
    }
  )

  ipcMain.handle(
    'models:remove',
    (_e, type: ModelType, name: string, provider?: string, diffusionType?: string, url?: string): void => {
      // Context-scoped delete (model-collision-hardening plan §3.3): the
      // renderer threads the row's provider/diffusionType (list rows) or the
      // catalog entry's fields + url (catalog-entry sites) so exactly ONE
      // path is deleted — never every provider subdir matching the basename.
      models.remove(type, name, provider, diffusionType, url)
    }
  )

  /**
   * Verify an installed model file's size against the server's content-length.
   * `expected` is 0 when the HEAD request fails (offline); in that case the
   * file is assumed fine (`ok: true`).
   *
   * `provider` / `diffusionType` are the catalog entry's fields, threaded by
   * the renderer; `url` doubles as pathFor's `expectUrl` (it IS the entry's
   * URL — no extra plumbing), so the resolution uses the precise
   * family/provider slot instead of a basename-global guess.
   */
  ipcMain.handle(
    'models:verify',
    async (
      _e,
      type: ModelType,
      name: string,
      url: string,
      provider?: string,
      diffusionType?: string
    ): Promise<{ ok: boolean; actual: number; expected: number; exists: boolean }> => {
      const p = models.pathFor(type, name, provider, diffusionType, url)
      const exists = existsSync(p)
      const actual = exists ? statSync(p).size : 0
      // Authenticated probe: the models:verify HEAD runs OUTSIDE the download
      // manager, so the manager's two header threads never reach it. Without
      // headers a private repo's HEAD answers 401 → expected === 0 → the
      // `expected === 0 || actual === expected` fallback below reports
      // ok: true with zero verification (a truncated private file always
      // passes). authHeadersForUrl yields {} when no source/token — the
      // pre-existing anonymous semantics.
      const expected = await headSize(url, undefined, undefined, await authHeadersForUrl(url))
      // `exists` distinguishes a MISSING file (actual 0) from a truncated one
      // — and fixes a latent hole: a missing file + a failed HEAD (expected 0)
      // used to report ok:true ("installed") and never re-download.
      return { ok: exists && (expected === 0 || actual === expected), actual, expected, exists }
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
  /**
   * Build the sd-cli command line for a generation request without actually
   * spawning the process. Returns the binary path and the full argument list
   * so the renderer can display it to the user (gen:preview flow).
   * Mirrors gen:start's resolution logic up to the buildArgs() call.
   */
  function previewGenerationCommand(req: GenerationRequest): Promise<{ binary: string; args: string[] }> {
    return new Promise(async (resolve, reject) => {
      try {
        const cfg = loadAllConfigs()
        let sampling = effectiveSampling(req.diffusionType, cfg)
        const modelBehavior = sampling.diffusion_behavior
        const vaeCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'vae', req.diffusionName)
        const encoderCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'encoder', req.diffusionName)
        const audioEncoderCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'audio_encoder', req.diffusionName)
        const visionCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'vision', req.diffusionName)
        const tokenizerCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'tokenizer', req.diffusionName)
        const audioVaeCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'audio_vae', req.diffusionName)
        const latentUpscalerCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'latent_upscaler', req.diffusionName)
        const hubRepo = cfg.hub.repo
        const pendingDeps: string[] = []
        const kickCompanionDownloads = (kind: CompanionKind, kickFamily: string): void => {
          for (const t of companionTargetsFor(kind, kickFamily)) {
            void models.download(t.type, t.url, () => {}, t.provider ?? 'default', false, t.family).catch(() => {})
          }
        }
        const kickNamedCompanion = (kind: CompanionKind, family: string, provider: string | undefined, name: string): boolean => {
          const row = catalogEntriesForLocation(kind, family, provider, name)[0]
          if (!row?.url) return false
          void models.download(kind, row.url, () => {}, row.provider ?? provider ?? 'default', false, family).catch(() => {})
          return true
        }
        const noteMisses = (kind: CompanionKind, missing: CompanionResolution['missing']): void => {
          if (!requiresDeclaresFor(cfg.hub, req.diffusionType, kind, req.diffusionName)) return
          for (const m of missing) {
            if (m.name) {
              kickNamedCompanion(kind, m.from, m.provider, m.name)
              kickCompanionDownloads(kind, m.from)
              pendingDeps.push(`${COMPANION_LABELS[kind]} "${m.name}"`)
            } else {
              pendingDeps.push(`the ${COMPANION_LABELS[kind]} for family "${m.from}" (the hub declares no default file for it)`)
            }
          }
        }

        const st = settings.get()
        const version = st.runtimeVersion ?? Object.keys(cfg.runtime.releases).sort((a, b) => Number(b) - Number(a))[0]
        const binary = runtime.binaryFor(version)
        if (!binary) { reject(new Error(`Runtime ${version} is not installed. Download it in Settings → Runtime.`)); return }

        const modelPath = models.pathFor('diffusion', req.model, req.modelProvider, req.diffusionType, expectUrlFor('diffusion', req.diffusionType, req.modelProvider, req.model))
        if (!existsSync(modelPath)) { reject(new Error(`Diffusion model not found: ${req.model}`)); return }
        const vaeRes = resolveCompanionPaths('vae', vaeCompanions, req.vae, req.vaeProvider, (f) => {
          const v = hubRepo.vae?.[f]
          return v === undefined ? '' : typeof v === 'string' ? v : v.default
        })
        if (req.vae && vaeRes.resolved.length === 0) { reject(new Error(`VAE not found: ${req.vae}`)); return }
        noteMisses('vae', vaeRes.missing)

        const encoderPaths: { path: string; useAs: string }[] = []
        if (req.encoders && req.encoders.length > 0) {
          for (const enc of req.encoders) {
            const comp = encoderCompanions.find((c) => c.useAs === enc.useAs) ?? encoderCompanions[0]
            const p = models.pathFor('encoder', enc.name, enc.provider, comp.from, expectUrlFor('encoder', comp.from, enc.provider, enc.name))
            if (!existsSync(p)) { reject(new Error(`Encoder not found: ${enc.name}`)); return }
            encoderPaths.push({ path: p, useAs: enc.useAs })
          }
        } else if (req.encoder) {
          const single = resolveCompanionPaths('encoder', [encoderCompanions[0]], req.encoder, req.encoderProvider)
          if (single.resolved.length === 0) { reject(new Error(`Encoder not found: ${req.encoder}`)); return }
          encoderPaths.push(...single.resolved)
        } else {
          const auto = resolveCompanionPaths('encoder', encoderCompanions, undefined, undefined, (f) => hubRepo.encoder?.[f]?.default ?? '')
          encoderPaths.push(...auto.resolved)
          noteMisses('encoder', auto.missing)
        }

        const audioEncoderRes = resolveCompanionPaths('audio_encoder', audioEncoderCompanions, req.audioEncoder, undefined, (f) => hubRepo.audio_encoder?.[f]?.default ?? '')
        if (req.audioEncoder && audioEncoderRes.resolved.length === 0) { reject(new Error(`Audio encoder not found: ${req.audioEncoder}`)); return }
        noteMisses('audio_encoder', audioEncoderRes.missing)

        const audioVaeRes = resolveCompanionPaths('audio_vae', audioVaeCompanions, req.audioVae, req.audioVaeProvider, (f) => hubRepo.audio_vae?.[f]?.default ?? '')
        const audioVaeDeclared = !!req.audioVae || audioVaeCompanions.some((c) => !!hubRepo.audio_vae?.[c.from]?.default)
        if (audioVaeDeclared && audioVaeRes.resolved.length === 0) { reject(new Error(`Audio VAE not found`)); return }
        noteMisses('audio_vae', audioVaeRes.missing)

        let highNoisePath: string | undefined
        {
          const entry = catalogEntriesForLocation('diffusion', req.diffusionType, req.modelProvider, req.model)[0]
          if (entry?.groupId) {
            const companion = catalogHighNoiseCompanion('diffusion', req.diffusionType, req.modelProvider, entry.groupId)
            if (companion) {
              const p = models.pathFor('diffusion', companion.name, req.modelProvider ?? companion.provider, req.diffusionType, companion.url)
              if (existsSync(p)) highNoisePath = p
            }
          }
        }

        const visionRes = resolveCompanionPaths('vision', visionCompanions, req.vision, undefined, (f) => hubRepo.vision?.[f]?.default ?? '')
        if (req.vision && visionRes.resolved.length === 0) { reject(new Error(`Vision model not found: ${req.vision}`)); return }
        noteMisses('vision', visionRes.missing)

        const tokenizerRes = resolveCompanionPaths('tokenizer', tokenizerCompanions, req.tokenizer, undefined, (f) => hubRepo.tokenizer?.[f]?.default ?? '')
        if (req.tokenizer && tokenizerRes.resolved.length === 0) { reject(new Error(`Tokenizer not found: ${req.tokenizer}`)); return }
        noteMisses('tokenizer', tokenizerRes.missing)

        // ---------- two-channel routing ----------
        const prevExists = !!req.previousImagePath && existsSync(req.previousImagePath)
        const refs: string[] = sampling.image_reference.show === true ? [...req.referencePaths] : []
        if (req.usePrevious && req.previousImageMode === 'reference' && sampling.image_reference.show === true && sampling.use_previous_image.show === true && prevExists) {
          if (!refs.includes(req.previousImagePath!)) refs.push(req.previousImagePath!)
        }
        if (refs.length > sampling.image_reference.max) refs.length = sampling.image_reference.max

        const inputImages: string[] = sampling.image_input.show === true ? [...(req.inputImagePaths ?? [])] : []
        if (req.usePrevious && req.previousImageMode === 'input' && sampling.image_input.show === true && sampling.use_previous_image.show === true && prevExists) {
          inputImages.unshift(req.previousImagePath!)
        }
        if (inputImages.length > sampling.image_input.max) inputImages.length = sampling.image_input.max
        const existingInputs = inputImages.filter((r) => existsSync(r)).slice(0, 1)

        const audioPath = sampling.audio_input.show === true && req.audioPath && existsSync(req.audioPath) ? req.audioPath : undefined
        const controlVideoDefault = typeof sampling.control_video?.default === 'string' && sampling.control_video.default.trim() ? sampling.control_video.default.trim() : undefined
        const controlVideoCandidate = req.controlVideoPath ?? controlVideoDefault
        const controlVideoPath = sampling.control_video.show === true && controlVideoCandidate && existsSync(controlVideoCandidate) ? controlVideoCandidate : undefined
        const endImagePath = sampling.end_image_input.show === true && req.endImagePath && existsSync(req.endImagePath) ? req.endImagePath : undefined
        const audioRefPaths = sampling.audio_reference.show === true ? [...new Set(req.audioReferencePaths ?? [])].filter((p) => existsSync(p)).slice(0, Math.max(0, sampling.audio_reference.max)) : []
        const videoRefPaths = sampling.video_reference.show === true ? [...new Set(req.videoReferencePaths ?? [])].filter((p) => existsSync(p)).slice(0, Math.max(0, sampling.video_reference.max)) : []

        const existingRefs = refs.filter((r) => existsSync(r))
        let initImage: string | undefined
        let maskPath: string | undefined
        if (req.maskPath && req.initImagePath) {
          if (sampling.allow_inpainting.show === true) {
            maskPath = req.maskPath
            initImage = req.initImagePath
            const i = existingRefs.indexOf(req.initImagePath)
            if (i >= 0) existingRefs.splice(i, 1)
          }
        }
        if (req.paintImagePath && sampling.allow_painting.show !== true) {
          req.paintImagePath = undefined
          req.paintTarget = undefined
        }
        const paintTarget = req.paintImagePath && (req.paintTarget === 'init' || req.paintTarget === 'reference') ? req.paintTarget : undefined
        if (req.paintImagePath && paintTarget && !(maskPath && initImage)) {
          if (paintTarget === 'init') {
            if (sampling.image_input.show === true) {
              initImage = req.paintImagePath
              const k = existingInputs.indexOf(req.paintImagePath)
              if (k >= 0) existingInputs.splice(k, 1)
              const r = existingRefs.indexOf(req.paintImagePath)
              if (r >= 0) existingRefs.splice(r, 1)
            }
          } else {
            if (sampling.image_reference.show === true) {
              const dup = existingRefs.indexOf(req.paintImagePath)
              if (dup >= 0) existingRefs.splice(dup, 1)
              if (existingRefs.length > 0) existingRefs[0] = req.paintImagePath
              else if (sampling.image_reference.max > 0) existingRefs.push(req.paintImagePath)
            }
          }
        }
        if (!initImage) initImage = existingInputs[0]
        if (initImage) {
          const j = existingInputs.indexOf(initImage)
          if (j >= 0) existingInputs.splice(j, 1)
        }

        const session = sessions.get(req.sessionId)
        if (!session) { reject(new Error(`Session ${req.sessionId} not found`)); return }

        const sessSampling = session.inputs?.sampling
        if (sessSampling) sampling = applySamplingOverrides(sampling, sessSampling)
        const negative = (req.negativePrompt ?? session.inputs?.negativePrompt ?? '').trim() || (sampling.negative.default ?? '').trim()
        if (negative) req.negativePrompt = negative
        const raw = req.scheduler ?? sampling.scheduler.default
        req.scheduler = raw && raw !== SCHEDULER_MODEL_DEFAULT && String(raw).trim() ? String(raw).trim() : undefined
        const rawFlow = req.flowShift ?? sampling.flow_shift.default
        req.flowShift = typeof rawFlow === 'number' && Number.isFinite(rawFlow) ? rawFlow : typeof rawFlow === 'string' && rawFlow.trim() !== '' && Number.isFinite(Number(rawFlow)) ? Number(rawFlow) : undefined
        const rawModelArgs = req.modelArgs ?? sampling.model_args?.default
        req.modelArgs = typeof rawModelArgs === 'string' && rawModelArgs.trim() !== '' ? rawModelArgs.trim() : undefined
        const rawSeed = req.seed ?? sessSampling?.seed ?? settings.get().sampling?.[req.diffusionType]?.seed
        req.seed = isValidSeed(rawSeed) ? Math.floor(rawSeed) : undefined
        const rawArgs = sessSampling?.args
        req.args = typeof rawArgs === 'string' && rawArgs.trim() !== '' ? rawArgs.trim() : undefined
        const posNum = (v: number | null | undefined): number | undefined => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
        if (sampling.mode === 'vid_gen') req.genMode = 'vid_gen'
        req.frames = posNum(sampling.frames?.default)
        req.frameRate = posNum(sampling.frame_rate?.default)
        req.highSteps = posNum(sampling.high_steps?.default)
        req.highCfg = typeof sampling.high_cfg?.default === 'number' && Number.isFinite(sampling.high_cfg.default) ? sampling.high_cfg.default : undefined
        req.highSampler = typeof sampling.high_sampler?.default === 'string' && sampling.high_sampler.default.trim() ? sampling.high_sampler.default.trim() : undefined
        req.upscale = sampling.upscale?.default === true
        req.upscalerSteps = posNum(sampling.upscaler_steps?.default)
        const latentUpscalerRes = req.upscale ? resolveCompanionPaths('latent_upscaler', latentUpscalerCompanions, req.latentUpscaler, req.latentUpscalerProvider, (f) => hubRepo.latent_upscaler?.[f]?.default ?? '') : { resolved: [], missing: [] }
        const latentUpscalerDeclared = !!req.latentUpscaler || latentUpscalerCompanions.some((c) => !!hubRepo.latent_upscaler?.[c.from]?.default)
        if (req.upscale && latentUpscalerDeclared && latentUpscalerRes.resolved.length === 0) { reject(new Error(`Latent upscaler not found`)); return }
        noteMisses('latent_upscaler', latentUpscalerRes.missing)

        if (pendingDeps.length > 0) { reject(new Error(`Required model files are missing (${pendingDeps.join(', ')})`)); return }

        let loraSpawn: { dir: string; mode: Exclude<LoraApplyMode, 'off'> } | undefined
        const loraCfg = session.inputs?.lora
        if (loraCfg && loraCfg.mode !== 'off') {
          const dir = loraCfg.dir && existsSync(loraCfg.dir) ? loraCfg.dir : join(dataRoot(), 'models', 'lora')
          mkdirSync(dir, { recursive: true })
          loraSpawn = { dir, mode: loraCfg.mode }
        }

        let adetailerSpawn: { model: string; options: Record<string, number | string>; adPrompt?: string; adNegativePrompt?: string } | undefined
        {
          const ad = session.inputs?.adetailer
          if (ad?.enabled && ad.model) {
            const resolvedPath = models.pathFor('adetailer', ad.model, ad.provider, undefined)
            if (basename(resolvedPath) !== ad.model) { reject(new Error(`ADetailer model mismatch: expected ${ad.model}, resolved to ${basename(resolvedPath)}`)); return }
            if (!existsSync(resolvedPath)) { reject(new Error(`ADetailer model not found: ${ad.model}`)); return }
            const opts: Record<string, number | string> = {}
            if (typeof ad.inputSize === 'number') opts.inputSize = ad.inputSize
            if (typeof ad.confidence === 'number') opts.confidence = ad.confidence
            if (typeof ad.nms === 'number') opts.nms = ad.nms
            if (typeof ad.maxDetections === 'number') opts.maxDetections = ad.maxDetections
            if (typeof ad.maskKLargest === 'number') opts.maskKLargest = ad.maskKLargest
            if (ad.maskFilterMethod) opts.maskFilterMethod = ad.maskFilterMethod
            if (typeof ad.maskMinRatio === 'number') opts.maskMinRatio = ad.maskMinRatio
            if (typeof ad.maskMaxRatio === 'number') opts.maskMaxRatio = ad.maskMaxRatio
            if (typeof ad.dilateErode === 'number') opts.dilateErode = ad.dilateErode
            if (typeof ad.offsetX === 'number') opts.offsetX = ad.offsetX
            if (typeof ad.offsetY === 'number') opts.offsetY = ad.offsetY
            if (ad.maskMode) opts.maskMode = ad.maskMode
            if (ad.mergeMasks) opts.mergeMasks = ad.mergeMasks
            if (ad.invertMask) opts.invertMask = ad.invertMask
            if (typeof ad.maskBlur === 'number') opts.maskBlur = ad.maskBlur
            if (typeof ad.inpaintPadding === 'number') opts.inpaintPadding = ad.inpaintPadding
            if (ad.inpaintOnlyMasked) opts.inpaintOnlyMasked = ad.inpaintOnlyMasked
            if (typeof ad.inpaintWidth === 'number') opts.inpaintWidth = ad.inpaintWidth
            if (typeof ad.inpaintHeight === 'number') opts.inpaintHeight = ad.inpaintHeight
            if (typeof ad.denoisingStrength === 'number') opts.denoisingStrength = ad.denoisingStrength
            if (ad.sortBy) opts.sortBy = ad.sortBy
            if (typeof ad.detailSteps === 'number') opts.detailSteps = ad.detailSteps
            if (typeof ad.detailCfg === 'number') opts.detailCfg = ad.detailCfg
            if (ad.detailSampler) opts.detailSampler = ad.detailSampler
            if (ad.detailScheduler) opts.detailScheduler = ad.detailScheduler
            if (ad.clipSkip != null) opts.clipSkip = ad.clipSkip
            const adPrompt = ad.adPrompt?.trim()
            const adNegativePrompt = ad.adNegativePrompt?.trim()
            adetailerSpawn = { model: resolvedPath, options: opts, ...(adPrompt ? { adPrompt } : {}), ...(adNegativePrompt ? { adNegativePrompt } : {}) }
          }
        }

        let ipAdapterSpawn: { model: string; clipVision: string; image: string; strength?: number } | undefined
        {
          const ipa = session.inputs?.ipAdapter
          if (ipa?.apply && ipa.model) {
            const family = req.diffusionType
            const modelPath2 = models.pathFor('ip_adapter', ipa.model, ipa.provider, family)
            if (basename(modelPath2) !== ipa.model) { reject(new Error(`IP Adapter model mismatch: expected ${ipa.model}, resolved to ${basename(modelPath2)}`)); return }
            if (!existsSync(modelPath2)) { reject(new Error(`IP Adapter model not found: ${ipa.model}`)); return }
            if (!ipa.clipVision) { reject(new Error('IP Adapter is enabled but no Clip Vision model is selected')); return }
            const cvPath = models.pathFor('clip_vision', ipa.clipVision, ipa.clipVisionProvider, family)
            if (basename(cvPath) !== ipa.clipVision) { reject(new Error(`Clip Vision model mismatch: expected ${ipa.clipVision}, resolved to ${basename(cvPath)}`)); return }
            if (!existsSync(cvPath)) { reject(new Error(`Clip Vision model not found: ${ipa.clipVision}`)); return }
            if (!ipa.image || !existsSync(ipa.image)) { reject(new Error('IP Adapter is enabled but the reference image is missing')); return }
            ipAdapterSpawn = { model: modelPath2, clipVision: cvPath, image: ipa.image, ...(typeof ipa.strength === 'number' && Number.isFinite(ipa.strength) && ipa.strength >= 0 ? { strength: ipa.strength } : {}) }
          }
        }

        let controlNetSpawn: { model: string; image: string; strength?: number } | undefined
        {
          const cn = session.inputs?.controlNet
          if (cn?.apply && cn.model) {
            const family = req.diffusionType
            const modelPath2 = models.pathFor('control_net', cn.model, cn.provider, family)
            if (basename(modelPath2) !== cn.model) { reject(new Error(`Control Net model mismatch: expected ${cn.model}, resolved to ${basename(modelPath2)}`)); return }
            if (!existsSync(modelPath2)) { reject(new Error(`Control Net model not found: ${cn.model}`)); return }
            if (!cn.image || !existsSync(cn.image)) { reject(new Error('Control Net is enabled but the control image is missing')); return }
            controlNetSpawn = { model: modelPath2, image: cn.image, ...(typeof cn.strength === 'number' && Number.isFinite(cn.strength) && cn.strength >= 0 ? { strength: cn.strength } : {}) }
          }
        }

        const output = newOutputPath(req.sessionId, 'preview', req.genMode === 'vid_gen' ? 'avi' : 'png')
        const paths = {
          model: modelPath,
          modelBehavior,
          highNoiseModel: highNoisePath,
          vae: vaeRes.resolved,
          encoder: encoderPaths,
          vision: visionRes.resolved,
          tokenizer: tokenizerRes.resolved,
          audioEncoder: audioEncoderRes.resolved,
          audioVae: audioVaeRes.resolved,
          latentUpscaler: latentUpscalerRes.resolved,
          lora: loraSpawn,
          adetailer: adetailerSpawn,
          ipAdapter: ipAdapterSpawn,
          controlNet: controlNetSpawn,
          initImage,
          mask: maskPath,
          references: existingRefs,
          audioPath,
          controlVideoPath,
          endImagePath,
          audioReferencePaths: audioRefPaths,
          videoReferencePaths: videoRefPaths,
          output
        }

        const perf = settings.get().performance
        if (perf?.enabled) req.performance = perf

        const args = buildArgs(req, paths)
        resolve({ binary, args })
      } catch (err) {
        reject(err)
      }
    })
  }

  ipcMain.handle('gen:preview', async (_e, req: GenerationRequest): Promise<{ binary: string; args: string[]; command: string }> => {
    const { binary, args } = await previewGenerationCommand(req)
    const quoteArg = (a: string): string => /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"')) ? `"${a}"` : a
    const command = [binary, ...args.map(quoteArg)].join(' ')
    return { binary, args, command }
  })

  ipcMain.handle('gen:start', async (_e, req: GenerationRequest): Promise<string> => {
    // One generation per session at a time: a second spawn would overwrite the
    // activeGens entry and orphan the first child (its Stop becomes
    // unreachable, its progress events interleave). The renderer gates this
    // via the per-session busy state (plans/session-switch-busy-state.md);
    // main is the enforcement point.
    if (activeGens.has(req.sessionId)) {
      throw new Error('A generation is already running in this session')
    }
    const cfg = loadAllConfigs()
    let sampling = effectiveSampling(req.diffusionType, cfg)
    // How the diffusion weights are passed: 'all_in_one' types ship a full
    // checkpoint (conditioners + VAE inside the file) and go out via `--model`;
    // 'standalone' types (default) go out via `--diffusion-model`.
    const modelBehavior = sampling.diffusion_behavior
    // Companion-model references: the hub entry's `requires` blocks route the
    // companion resolution to a DIFFERENT diffusion family (e.g. wan2_2_t2v
    // uses the wan2_1 VAE + encoder). The arrays are NEVER empty — an
    // undeclared kind falls back to the session's own diffusionType under the
    // kind's default CLI flag, so every site keeps today's behavior when no
    // `requires` block exists.
    const vaeCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'vae', req.diffusionName)
    const encoderCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'encoder', req.diffusionName)
    const audioEncoderCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'audio_encoder', req.diffusionName)
    const visionCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'vision', req.diffusionName)
    const tokenizerCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'tokenizer', req.diffusionName)
    const audioVaeCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'audio_vae', req.diffusionName)
    const latentUpscalerCompanions = requiresCompanionsFor(cfg.hub, req.diffusionType, 'latent_upscaler', req.diffusionName)
    // ONE hub-repo read for every hubDefaultFor stale-cache backstop below.
    const hubRepo = cfg.hub.repo
    // Missing-companion self-heal state: the resolution sites below report
    // what they could not resolve; the funnel after the last site kicks the
    // downloads (for REQUIRES-declared kinds — undeclared kinds keep today's
    // silent-skip semantics) and fails this generation with a retry hint, so
    // the currently selected model's dependencies always (re)download instead
    // of silently spawning without them. The Downloads list shows live
    // progress; the next Send succeeds once the files land.
    const pendingDeps: string[] = []
    const kickCompanionDownloads = (kind: CompanionKind, kickFamily: string): void => {
      for (const t of companionTargetsFor(kind, kickFamily)) {
        void models
          .download(t.type, t.url, () => {}, t.provider ?? 'default', false, t.family)
          .catch((err: unknown) => {
            console.warn(
              `[gen] companion download failed (${t.name}): ${(err as Error)?.message ?? String(err)}`
            )
          })
      }
    }
    /** Best-effort exact-file re-download: the cached catalog row at this
     * (type, family, provider, name) location carries the precise URL. True
     * when a download was kicked. */
    const kickNamedCompanion = (
      kind: CompanionKind,
      family: string,
      provider: string | undefined,
      name: string
    ): boolean => {
      const row = catalogEntriesForLocation(kind, family, provider, name)[0]
      if (!row?.url) return false
      void models
        .download(kind, row.url, () => {}, row.provider ?? provider ?? 'default', false, family)
        .catch((err: unknown) => {
          console.warn(
            `[gen] companion download failed (${name}): ${(err as Error)?.message ?? String(err)}`
          )
        })
      return true
    }
    /** Record a declared kind's missing items: kick the exact file (when the
     * request named one) AND the family's fresh-config defaults, and queue
     * the human-readable summary for the funnel's error. */
    const noteMisses = (kind: CompanionKind, missing: CompanionResolution['missing']): void => {
      if (!requiresDeclaresFor(cfg.hub, req.diffusionType, kind, req.diffusionName)) return
      for (const m of missing) {
        if (m.name) {
          kickNamedCompanion(kind, m.from, m.provider, m.name)
          kickCompanionDownloads(kind, m.from)
          pendingDeps.push(`${COMPANION_LABELS[kind]} "${m.name}"`)
        } else {
          pendingDeps.push(
            `the ${COMPANION_LABELS[kind]} for family "${m.from}" (the hub declares no default file for it)`
          )
        }
      }
    }

    const st = settings.get()
    const version = st.runtimeVersion ?? Object.keys(cfg.runtime.releases).sort((a, b) => Number(b) - Number(a))[0]
    const binary = runtime.binaryFor(version)
    if (!binary) {
      throw new Error(`Runtime ${version} is not installed. Download it in Settings â†’ Runtime.`)
    }

    // Every resolution site passes the request's diffusionType as the FAMILY
    // plus its own provider field, and pins its catalog entry's URL as
    // `expectUrl` (model-collision-hardening plan §3.6): pathFor's
    // cross-family/cross-provider fallback steps only serve a candidate whose
    // exact location carries an entry with that URL — a wrong-family
    // same-basename file from a DIFFERENT URL can no longer be loaded
    // silently (findings F1/F2). When the catalog yields nothing (wiped
    // cache, renamed/deleted file) expectUrl is undefined and the chain
    // degrades permissively.
    const modelPath = models.pathFor(
      'diffusion',
      req.model,
      req.modelProvider,
      req.diffusionType,
      expectUrlFor('diffusion', req.diffusionType, req.modelProvider, req.model)
    )
    if (!existsSync(modelPath)) throw new Error(`Diffusion model not found: ${req.model}`)
    const vaeRes = resolveCompanionPaths(
      'vae',
      vaeCompanions,
      req.vae,
      req.vaeProvider,
      // repo.vae still accepts the legacy plain-URL string form — its
      // "default" is the URL itself (resolveCompanionPaths basenames it).
      (f) => {
        const v = hubRepo.vae?.[f]
        return v === undefined ? '' : typeof v === 'string' ? v : v.default
      }
    )
    if (req.vae && vaeRes.resolved.length === 0) {
      // Best-effort exact-file re-download (the catalog row's URL at this
      // location), falling back to the family's fresh-config default
      // download — then the pre-existing loud failure, with a retry hint when
      // the kick actually started something.
      const kicked = kickNamedCompanion('vae', vaeCompanions[0].from, req.vaeProvider, req.vae)
      if (!kicked) kickCompanionDownloads('vae', vaeCompanions[0].from)
      throw new Error(
        `VAE not found: ${req.vae}${kicked ? ' — downloading it now; try again in a moment' : ''}`
      )
    }
    noteMisses('vae', vaeRes.missing)
    // Encoder — THREE input paths merged into ONE companion array (the
    // SdCliPaths.encoder/encoders XOR guard dissolves into the unified shape):
    // 1. the renderer-sent `req.encoders` bundle (SD3.5 defaults[] or an
    //    array-form requires.encoder): each file resolves WITH its own
    //    provider (previously dropped — with SD3.5's and Flux's
    //    clip_l.safetensors both installed, both families resolved to
    //    whichever provider dir sorted first → the wrong file loaded
    //    silently), from the companion whose useAs matches, else the first
    //    companion's family (the scalar `requires.encoder.from` / the
    //    session's own diffusionType) — the per-item mapping that serves
    //    hunyuan_video_1_5's two-encoder array (qwen2_5_vl under
    //    `qwen2_5_vl_7b_instruct`, byt5 under `byt5_small_glyphxl` — never one
    //    shared family);
    // 2. the single-file legacy `req.encoder` (first companion's family);
    // 3. no request names — derive each companion's default from its OWN
    //    family's hub config (only files already on disk are emitted; the
    //    stale-cache self-heal).
    const encoderPaths: { path: string; useAs: string }[] = []
    if (req.encoders && req.encoders.length > 0) {
      for (const enc of req.encoders) {
        const comp = encoderCompanions.find((c) => c.useAs === enc.useAs) ?? encoderCompanions[0]
        const p = models.pathFor(
          'encoder',
          enc.name,
          enc.provider,
          comp.from,
          expectUrlFor('encoder', comp.from, enc.provider, enc.name)
        )
        if (!existsSync(p)) {
          // Best-effort exact-file re-download, then the pre-existing loud
          // failure — with a retry hint when the kick started something.
          const kicked = kickNamedCompanion('encoder', comp.from, enc.provider, enc.name)
          if (!kicked) kickCompanionDownloads('encoder', comp.from)
          throw new Error(
            `Encoder not found: ${enc.name}${kicked ? ' — downloading it now; try again in a moment' : ''}`
          )
        }
        encoderPaths.push({ path: p, useAs: enc.useAs })
      }
    } else if (req.encoder) {
      const single = resolveCompanionPaths(
        'encoder',
        [encoderCompanions[0]],
        req.encoder,
        req.encoderProvider
      )
      if (single.resolved.length === 0) {
        const kicked = kickNamedCompanion(
          'encoder',
          encoderCompanions[0].from,
          req.encoderProvider,
          req.encoder
        )
        if (!kicked) kickCompanionDownloads('encoder', encoderCompanions[0].from)
        throw new Error(
          `Encoder not found: ${req.encoder}${kicked ? ' — downloading it now; try again in a moment' : ''}`
        )
      }
      encoderPaths.push(...single.resolved)
    } else {
      const auto = resolveCompanionPaths('encoder', encoderCompanions, undefined, undefined, (f) =>
        hubRepo.encoder?.[f]?.default ?? ''
      )
      encoderPaths.push(...auto.resolved)
      noteMisses('encoder', auto.missing)
    }
    // Audio encoder (Wan2.2 S2V's wav2vec2) — resolved from the family the
    // hub entry's `requires.audio_encoder.from` names (else the session's own
    // diffusionType).
    const audioEncoderRes = resolveCompanionPaths(
      'audio_encoder',
      audioEncoderCompanions,
      req.audioEncoder,
      undefined,
      (f) => hubRepo.audio_encoder?.[f]?.default ?? ''
    )
    if (req.audioEncoder && audioEncoderRes.resolved.length === 0) {
      const kicked = kickNamedCompanion(
        'audio_encoder',
        audioEncoderCompanions[0].from,
        undefined,
        req.audioEncoder
      )
      if (!kicked) kickCompanionDownloads('audio_encoder', audioEncoderCompanions[0].from)
      throw new Error(
        `Audio encoder not found: ${req.audioEncoder}${kicked ? ' — downloading it now; try again in a moment' : ''}`
      )
    }
    noteMisses('audio_encoder', audioEncoderRes.missing)
    // Audio VAE (LTX 2.5's audio track) — resolved from the companion family
    // (the hub entry's `requires.audio_vae.from` when declared, else the
    // session's own diffusionType). Resolves UNCONDITIONALLY when the family
    // declares one (LTX needs `--audio-vae` on every run) and does NOT depend
    // on the upscale gate, so this early site is safe. Stale-cache backstop:
    // when the request omits the name (a legacy catalog cache has no audio_vae
    // rows), derive the default basename from the FRESH hub config —
    // expectUrlFor degrades permissively on a stale cache, so the file still
    // resolves by family/provider/name. An empty derived name (the family
    // declares nothing) resolves nothing and emits nothing. The missing-file
    // throw is DECLARED-keyed — the auto-derived audio VAE is a required
    // companion, so a declared-but-missing file fails the generation even when
    // the request omits the name (preserved from the pre-unified site).
    const audioVaeRes = resolveCompanionPaths(
      'audio_vae',
      audioVaeCompanions,
      req.audioVae,
      req.audioVaeProvider,
      (f) => hubRepo.audio_vae?.[f]?.default ?? ''
    )
    const audioVaeDeclared =
      !!req.audioVae || audioVaeCompanions.some((c) => !!hubRepo.audio_vae?.[c.from]?.default)
    if (audioVaeDeclared && audioVaeRes.resolved.length === 0) {
      const missName = req.audioVae ?? basename(hubRepo.audio_vae?.[audioVaeCompanions[0].from]?.default ?? '')
      const kicked = req.audioVae
        ? kickNamedCompanion('audio_vae', audioVaeCompanions[0].from, req.audioVaeProvider, req.audioVae)
        : false
      if (!kicked) kickCompanionDownloads('audio_vae', audioVaeCompanions[0].from)
      throw new Error(
        `Audio VAE not found: ${missName}` +
          `${kicked ? ' — downloading it now; try again in a moment' : ' — download it in Settings → Audio VAE'}`
      )
    }
    noteMisses('audio_vae', audioVaeRes.missing)
    // High-noise expert (WAN MoE pairs): the low-noise file the user selected
    // carries a `groupId`; the high-noise companion is the catalog entry with
    // the same group whose `useAs` is `high_noise_diffusion_model`. A MoE
    // pair is not optional — a missing companion fails the generation with a
    // rescan hint (a stale catalog cache has no groupId rows).
    let highNoisePath: string | undefined
    {
      const entry = catalogEntriesForLocation(
        'diffusion',
        req.diffusionType,
        req.modelProvider,
        req.model
      )[0]
      if (entry?.groupId) {
        const companion = catalogHighNoiseCompanion(
          'diffusion',
          req.diffusionType,
          req.modelProvider,
          entry.groupId
        )
        if (companion) {
          const p = models.pathFor(
            'diffusion',
            companion.name,
            req.modelProvider ?? companion.provider,
            req.diffusionType,
            companion.url
          )
          if (existsSync(p)) highNoisePath = p
          else throw new Error(`High-noise model not found: ${companion.name} (download the full MoE pair)`)
        } else {
          throw new Error(
            `High-noise model entry missing for ${req.model} — Refresh the hub in Settings → Models`
          )
        }
      }
    }
    const visionRes = resolveCompanionPaths(
      'vision',
      visionCompanions,
      req.vision,
      undefined,
      (f) => hubRepo.vision?.[f]?.default ?? ''
    )
    if (req.vision && visionRes.resolved.length === 0) {
      const kicked = kickNamedCompanion('vision', visionCompanions[0].from, undefined, req.vision)
      if (!kicked) kickCompanionDownloads('vision', visionCompanions[0].from)
      throw new Error(
        `Vision model not found: ${req.vision}${kicked ? ' — downloading it now; try again in a moment' : ''}`
      )
    }
    noteMisses('vision', visionRes.missing)
    const tokenizerRes = resolveCompanionPaths(
      'tokenizer',
      tokenizerCompanions,
      req.tokenizer,
      undefined,
      (f) => hubRepo.tokenizer?.[f]?.default ?? ''
    )
    if (req.tokenizer && tokenizerRes.resolved.length === 0) {
      const kicked = kickNamedCompanion('tokenizer', tokenizerCompanions[0].from, undefined, req.tokenizer)
      if (!kicked) kickCompanionDownloads('tokenizer', tokenizerCompanions[0].from)
      throw new Error(
        `Tokenizer not found: ${req.tokenizer}${kicked ? ' — downloading it now; try again in a moment' : ''}`
      )
    }
    noteMisses('tokenizer', tokenizerRes.missing)

    // ---------- two-channel routing ----------
    // Reference channel (--ref-image): user-picked references plus the
    // previous image when chained "As Reference". Defense-in-depth: a
    // request's referencePaths are dropped for a type that forbids them, and
    // previous-image chaining is dropped when `use_previous_image.show` is
    // false (the renderer hides the checkbox; this is the main-side backstop).
    const prevExists = !!req.previousImagePath && existsSync(req.previousImagePath)
    const refs: string[] = sampling.image_reference.show === true ? [...req.referencePaths] : []
    if (
      req.usePrevious &&
      req.previousImageMode === 'reference' &&
      sampling.image_reference.show === true &&
      sampling.use_previous_image.show === true &&
      prevExists
    ) {
      if (!refs.includes(req.previousImagePath!)) refs.push(req.previousImagePath!)
    }
    if (refs.length > sampling.image_reference.max) refs.length = sampling.image_reference.max

    // Input channel (--init-img): user-picked input images plus the previous
    // image when chained "As input". --init-img is single-valued, so only the
    // first valid path survives; the previous image takes the slot ahead of
    // any user-picked inputs (first valid wins). Defense-in-depth: the
    // channel is dropped entirely for a type that forbids it, and
    // previous-image chaining is dropped when `use_previous_image.show` is
    // false (the renderer hides the checkbox; this is the main-side backstop).
    const inputImages: string[] =
      sampling.image_input.show === true ? [...(req.inputImagePaths ?? [])] : []
    if (
      req.usePrevious &&
      req.previousImageMode === 'input' &&
      sampling.image_input.show === true &&
      sampling.use_previous_image.show === true &&
      prevExists
    ) {
      inputImages.unshift(req.previousImagePath!)
    }
    if (inputImages.length > sampling.image_input.max) {
      inputImages.length = sampling.image_input.max
    }
    const existingInputs = inputImages.filter((r) => existsSync(r)).slice(0, 1)

    // Video-era channels (descriptor-gated; each flag is single-valued, so a
    // stale or forbidden path is dropped entirely — defense-in-depth):
    // --audio (Wan2.2 S2V), --control-video (VACE, a frames DIRECTORY),
    // --end-img (FLF2V). The control-video gate is the `control_video`
    // descriptor's `show` (NOT video_input — that channel is reserved); when
    // the request carries no explicit user-picked directory, the descriptor's
    // `default` (a configured frames directory, usually null) is the fallback.
    const audioPath =
      sampling.audio_input.show === true &&
      req.audioPath &&
      existsSync(req.audioPath)
        ? req.audioPath
        : undefined
    const controlVideoDefault =
      typeof sampling.control_video?.default === 'string' && sampling.control_video.default.trim()
        ? sampling.control_video.default.trim()
        : undefined
    const controlVideoCandidate = req.controlVideoPath ?? controlVideoDefault
    const controlVideoPath =
      sampling.control_video.show === true &&
      controlVideoCandidate &&
      existsSync(controlVideoCandidate)
        ? controlVideoCandidate
        : undefined
    const endImagePath =
      sampling.end_image_input.show === true &&
      req.endImagePath &&
      existsSync(req.endImagePath)
        ? req.endImagePath
        : undefined
    // Reference channels (--ref-audio / --ref-video, MiniMax-H3 Ref2VA) —
    // REPEATABLE flags, so they follow the image_reference pattern (arrays,
    // deduped, existsSync-filtered, capped by the channel `max`); a type whose
    // config forbids the channel gets an empty array (drop entirely,
    // defense-in-depth). --ref-video takes a frames DIRECTORY at 24 fps, not
    // a media file.
    const audioRefPaths =
      sampling.audio_reference.show === true
        ? [...new Set(req.audioReferencePaths ?? [])]
            .filter((p) => existsSync(p))
            .slice(0, Math.max(0, sampling.audio_reference.max))
        : []
    const videoRefPaths =
      sampling.video_reference.show === true
        ? [...new Set(req.videoReferencePaths ?? [])]
            .filter((p) => existsSync(p))
            .slice(0, Math.max(0, sampling.video_reference.max))
        : []
    // Write the GATED values back onto the request — buildArgs() reads the
    // req.* fields (sdcli.ts), so without this the gate above would only
    // protect the persisted message display, never the emitted flags.
    req.audioPath = audioPath
    req.controlVideoPath = controlVideoPath
    req.endImagePath = endImagePath
    req.audioReferencePaths = audioRefPaths
    req.videoReferencePaths = videoRefPaths

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
      if (sampling.allow_inpainting.show === true) {
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
    if (req.paintImagePath && sampling.allow_painting.show !== true) {
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
        if (sampling.image_input.show === true) {
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
        if (sampling.image_reference.show === true) {
          // Remove any duplicate occurrence first, then take slot 0 — or
          // become the only ref when the channel is empty (guarded against a
          // degenerate show + max 0 config).
          const dup = existingRefs.indexOf(req.paintImagePath)
          if (dup >= 0) existingRefs.splice(dup, 1)
          if (existingRefs.length > 0) existingRefs[0] = req.paintImagePath
          else if (sampling.image_reference.max > 0) existingRefs.push(req.paintImagePath)
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

    // Session-level sampling override (flat scalars) merges into the
    // descriptor defaults — the channels (image_reference / image_input /
    // ...) are NOT session-overridable and stay as loaded. steps/cfg/strength
    // already arrive merged in `req` from the renderer, so this is
    // defense-in-depth; what main actually needs is the fallback reads below
    // (negative / scheduler / flow_shift / frames / high-noise values).
    // Width/height are not session-overridable — the resolution selected in
    // the chat panel always wins.
    const sessSampling = session.inputs?.sampling
    if (sessSampling) sampling = applySamplingOverrides(sampling, sessSampling)
    // Negative prompt: request value (sent by renderer) wins; else the session
    // file's saved value (defense-in-depth); else the global per-type default.
    const negative =
      (req.negativePrompt ?? session.inputs?.negativePrompt ?? '').trim() ||
      (sampling.negative.default ?? '').trim()
    if (negative) req.negativePrompt = negative
    // Scheduler: `req.scheduler` carries the RAW renderer value (a concrete
    // string, the 'model-specific' sentinel, or undefined). Resolve the
    // sentinel and the global fallback here in one place. A concrete value
    // survives; a sentinel vanishes WITHOUT triggering the global fallback;
    // only an absent value falls back to the global default.
    const raw = req.scheduler ?? sampling.scheduler.default
    req.scheduler = raw && raw !== SCHEDULER_MODEL_DEFAULT && String(raw).trim() ? String(raw).trim() : undefined
    // Flow shift: `req.flowShift` carries the RAW renderer value (a finite
    // number, '', null, or undefined). Request value wins; else the global
    // effective default. A finite number (incl 0) or a numeric string
    // survives; '' / null / undefined / non-numeric => undefined => buildArgs
    // emits no --flow-shift flag (sd-cli default: auto).
    const rawFlow = req.flowShift ?? sampling.flow_shift.default
    req.flowShift =
      typeof rawFlow === 'number' && Number.isFinite(rawFlow)
        ? rawFlow
        : typeof rawFlow === 'string' && rawFlow.trim() !== '' && Number.isFinite(Number(rawFlow))
          ? Number(rawFlow)
          : undefined
    // Model args: `req.modelArgs` carries the RAW renderer value (a concrete
    // string, or undefined). Request value wins; else the global effective
    // default. A non-empty trimmed string survives; '' / null / undefined ⇒
    // undefined ⇒ buildArgs emits no --model-args flag (sd-cli default).
    const rawModelArgs = req.modelArgs ?? sampling.model_args?.default
    req.modelArgs = typeof rawModelArgs === 'string' && rawModelArgs.trim() !== '' ? rawModelArgs.trim() : undefined
    // Seed: `req.seed` carries the RAW merged value (a finite integer in
    // [0, SEED_MAX], null, or undefined). Request value wins; else the
    // session-saved override, else the settings per-type override (seed is
    // NOT a sampling.json field). A valid integer survives as a fixed seed;
    // anything else => undefined => buildArgs generates a fresh random seed
    // per run.
    const rawSeed = req.seed ?? sessSampling?.seed ?? settings.get().sampling?.[req.diffusionType]?.seed
    req.seed = isValidSeed(rawSeed) ? Math.floor(rawSeed) : undefined
    // Universal args: session-only (never a sampling.json field). A non-empty
    // trimmed string survives; '' / null / undefined ⇒ undefined ⇒ buildArgs
    // appends nothing.
    const rawArgs = sessSampling?.args
    req.args = typeof rawArgs === 'string' && rawArgs.trim() !== '' ? rawArgs.trim() : undefined
    // Video-era values (descriptors resolved post-merge): gen mode, video
    // frames / frame rate and the MoE high-noise sampling values. Positive
    // numbers only for frames/fps/high-steps (0 or null ⇒ the flag is omitted
    // and sd-cli's own default applies); `highCfg` keeps 0 as a legal value.
    // Optional chaining on the MoE-only descriptors (high_cfg / high_sampler):
    // most sampling.json types omit them entirely — only VACE defines them.
    const posNum = (v: number | null | undefined): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    if (sampling.mode === 'vid_gen') req.genMode = 'vid_gen'
    req.frames = posNum(sampling.frames?.default)
    req.frameRate = posNum(sampling.frame_rate?.default)
    req.highSteps = posNum(sampling.high_steps?.default)
    req.highCfg =
      typeof sampling.high_cfg?.default === 'number' && Number.isFinite(sampling.high_cfg.default)
        ? sampling.high_cfg.default
        : undefined
    req.highSampler =
      typeof sampling.high_sampler?.default === 'string' && sampling.high_sampler.default.trim()
        ? sampling.high_sampler.default.trim()
        : undefined
    // Highres fix (LTX spatial-latent upscale): the two new descriptors are
    // main-resolved like frames/highSteps — the renderer sends nothing.
    // `upscale` is a definite boolean (checkbox semantics); `upscalerSteps`
    // keeps a positive value (0/null ⇒ --hires-steps omitted ⇒ sd-cli
    // default 0 = reuse --steps).
    req.upscale = sampling.upscale?.default === true
    req.upscalerSteps = posNum(sampling.upscaler_steps?.default)
    // Latent upscaler (LTX 2.5 hires fix) — resolved from the companion
    // family (the hub entry's `requires.latent_upscaler.from` when declared,
    // else the session's own diffusionType). GATED on `req.upscale`, which
    // only exists once the merged descriptor has been read above — placing
    // this at the audio-encoder site would read `req.upscale` before it is
    // assigned, the path would never resolve, and buildArgs would silently
    // drop the two upscaler flags. Same stale-cache backstop as the audio
    // VAE: the name derives from the fresh hub config when the request omits
    // it. The missing-file throw is DECLARED-keyed (NOT keyed on
    // `req.latentUpscaler`, which is absent on the backstop path): a family
    // that DECLARES an upscaler but whose file is missing fails the
    // generation (a required companion, like the MoE high-noise expert —
    // never a silent quality downgrade); a family that declares NOTHING
    // resolves nothing and buildArgs falls back to sd-cli's built-in upscaler.
    const latentUpscalerRes = req.upscale
      ? resolveCompanionPaths(
          'latent_upscaler',
          latentUpscalerCompanions,
          req.latentUpscaler,
          req.latentUpscalerProvider,
          (f) => hubRepo.latent_upscaler?.[f]?.default ?? ''
        )
      : { resolved: [], missing: [] }
    const latentUpscalerDeclared =
      !!req.latentUpscaler ||
      latentUpscalerCompanions.some((c) => !!hubRepo.latent_upscaler?.[c.from]?.default)
    if (req.upscale && latentUpscalerDeclared && latentUpscalerRes.resolved.length === 0) {
      const missName =
        req.latentUpscaler ?? basename(hubRepo.latent_upscaler?.[latentUpscalerCompanions[0].from]?.default ?? '')
      const kicked = req.latentUpscaler
        ? kickNamedCompanion(
            'latent_upscaler',
            latentUpscalerCompanions[0].from,
            req.latentUpscalerProvider,
            req.latentUpscaler
          )
        : false
      if (!kicked) kickCompanionDownloads('latent_upscaler', latentUpscalerCompanions[0].from)
      throw new Error(
        `Latent upscaler not found: ${missName}` +
          `${kicked ? ' — downloading it now; try again in a moment' : ' — download it in Settings → Latent Upscaler'}`
      )
    }
    noteMisses('latent_upscaler', latentUpscalerRes.missing)

    // Self-heal funnel: every REQUIRES-declared companion the sites above
    // could not resolve has had its download kicked — fail this generation
    // with a retry hint instead of silently spawning without the dependency.
    if (pendingDeps.length > 0) {
      throw new Error(
        `Required model files are missing and are being downloaded now (${pendingDeps.join(', ')}) — try again once the Downloads list shows them complete`
      )
    }

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
    // ADetailer (YOLOv8 object detector repair pass): resolved from the
    // session's saved adetailer settings - when enabled, the model path is
    // resolved and the basename is validated against the session's model
    // name (collision-hardening plan). Options are built from the session's
    // AdetailerSettings and emitted as --extra-ad-args.
    let adetailerSpawn: {
      model: string
      options: Record<string, number | string>
      adPrompt?: string
      adNegativePrompt?: string
    } | undefined
    {
      const ad = session.inputs?.adetailer
      if (ad?.enabled && ad.model) {
        const resolvedPath = models.pathFor(
          'adetailer',
          ad.model,
          ad.provider, // provider scopes the on-disk slot so two providers
          undefined // shipping the same basename resolve to different dirs
          // adetailer has no diffusion-type variation
        )
        // Basename validation: the resolved path must carry the session's
        // model name as its basename (the family-scoped pathFor chain may
        // serve a different URL's file under the same basename - reject).
        if (basename(resolvedPath) !== ad.model) {
          throw new Error(
            `ADetailer model mismatch: expected ${ad.model}, resolved to ${basename(resolvedPath)}`
          )
        }
        if (!existsSync(resolvedPath)) {
          throw new Error(`ADetailer model not found: ${ad.model} - download it in Settings -> Adetailer`)
        }
        // Build --extra-ad-args from the session's AdetailerSettings
        const opts: Record<string, number | string> = {}
        if (typeof ad.inputSize === 'number') opts.inputSize = ad.inputSize
        if (typeof ad.confidence === 'number') opts.confidence = ad.confidence
        if (typeof ad.nms === 'number') opts.nms = ad.nms
        if (typeof ad.maxDetections === 'number') opts.maxDetections = ad.maxDetections
        if (typeof ad.maskKLargest === 'number') opts.maskKLargest = ad.maskKLargest
        if (ad.maskFilterMethod) opts.maskFilterMethod = ad.maskFilterMethod
        if (typeof ad.maskMinRatio === 'number') opts.maskMinRatio = ad.maskMinRatio
        if (typeof ad.maskMaxRatio === 'number') opts.maskMaxRatio = ad.maskMaxRatio
        if (typeof ad.dilateErode === 'number') opts.dilateErode = ad.dilateErode
        if (typeof ad.offsetX === 'number') opts.offsetX = ad.offsetX
        if (typeof ad.offsetY === 'number') opts.offsetY = ad.offsetY
        if (ad.maskMode) opts.maskMode = ad.maskMode
        if (ad.mergeMasks) opts.mergeMasks = ad.mergeMasks
        if (ad.invertMask) opts.invertMask = ad.invertMask
        if (typeof ad.maskBlur === 'number') opts.maskBlur = ad.maskBlur
        if (typeof ad.inpaintPadding === 'number') opts.inpaintPadding = ad.inpaintPadding
        if (ad.inpaintOnlyMasked) opts.inpaintOnlyMasked = ad.inpaintOnlyMasked
        if (typeof ad.inpaintWidth === 'number') opts.inpaintWidth = ad.inpaintWidth
        if (typeof ad.inpaintHeight === 'number') opts.inpaintHeight = ad.inpaintHeight
        if (typeof ad.denoisingStrength === 'number') opts.denoisingStrength = ad.denoisingStrength
        if (ad.sortBy) opts.sortBy = ad.sortBy
        if (typeof ad.detailSteps === 'number') opts.detailSteps = ad.detailSteps
        if (typeof ad.detailCfg === 'number') opts.detailCfg = ad.detailCfg
        if (ad.detailSampler) opts.detailSampler = ad.detailSampler
        if (ad.detailScheduler) opts.detailScheduler = ad.detailScheduler
        if (ad.clipSkip != null) opts.clipSkip = ad.clipSkip
        // Thread prompt overrides onto the request (buildArgs reads these)
        const adPrompt = ad.adPrompt?.trim()
        const adNegativePrompt = ad.adNegativePrompt?.trim()
        adetailerSpawn = {
          // Pass the ABSOLUTE path — sd-cli resolves the detector file itself
          // and needs the full path, not just the basename (a bare basename
          // fails with "cannot inspect model source ... file specified").
          model: resolvedPath,
          options: opts,
          ...(adPrompt ? { adPrompt } : {}),
          ...(adNegativePrompt ? { adNegativePrompt } : {})
        }
      }
    }

    // IP Adapter (CLIP-Vision encoder + adapter weight + reference image):
    // resolved from the session's saved ipAdapter settings; early clear error
    // when apply is on but clip vision or reference image is missing.
    let ipAdapterSpawn: { model: string; clipVision: string; image: string; strength?: number } | undefined
    {
      const ipa = session.inputs?.ipAdapter
      if (ipa?.apply && ipa.model) {
        const family = req.diffusionType
        const modelPath = models.pathFor('ip_adapter', ipa.model, ipa.provider, family)
        if (basename(modelPath) !== ipa.model) {
          throw new Error(
            `IP Adapter model mismatch: expected ${ipa.model}, resolved to ${basename(modelPath)}`
          )
        }
        if (!existsSync(modelPath)) {
          throw new Error(`IP Adapter model not found: ${ipa.model} - download it in the IP Adapter dialog`)
        }
        if (!ipa.clipVision) {
          throw new Error('IP Adapter is enabled but no Clip Vision model is selected - open the IP Adapter dialog and pick/download one (Tab: Clip Vision)')
        }
        const cvPath = models.pathFor('clip_vision', ipa.clipVision, ipa.clipVisionProvider, family)
        if (basename(cvPath) !== ipa.clipVision) {
          throw new Error(
            `Clip Vision model mismatch: expected ${ipa.clipVision}, resolved to ${basename(cvPath)}`
          )
        }
        if (!existsSync(cvPath)) {
          throw new Error(`Clip Vision model not found: ${ipa.clipVision} - download it in the IP Adapter dialog`)
        }
        if (!ipa.image || !existsSync(ipa.image)) {
          throw new Error('IP Adapter is enabled but the reference image is missing - re-attach it in the IP Adapter dialog')
        }
        ipAdapterSpawn = {
          model: modelPath,
          clipVision: cvPath,
          image: ipa.image,
          ...(typeof ipa.strength === 'number' && Number.isFinite(ipa.strength) && ipa.strength >= 0 ? { strength: ipa.strength } : {})
        }
      }
    }

    // Control Net (control net model + control image): resolved from the
    // session's saved controlNet settings; early clear error when apply is on
    // but the model or control image is missing.
    let controlNetSpawn: { model: string; image: string; strength?: number } | undefined
    {
      const cn = session.inputs?.controlNet
      if (cn?.apply && cn.model) {
        const family = req.diffusionType
        const cnModelPath = models.pathFor('control_net', cn.model, cn.provider, family)
        if (basename(cnModelPath) !== cn.model) {
          throw new Error(
            `Control Net model mismatch: expected ${cn.model}, resolved to ${basename(cnModelPath)}`
          )
        }
        if (!existsSync(cnModelPath)) {
          throw new Error(`Control Net model not found: ${cn.model} - download it in the Control Net dialog`)
        }
        if (!cn.image || !existsSync(cn.image)) {
          throw new Error('Control Net is enabled but the control image is missing - re-attach it in the Control Net dialog')
        }
        controlNetSpawn = {
          model: cnModelPath,
          image: cn.image,
          ...(typeof cn.strength === 'number' && Number.isFinite(cn.strength) && cn.strength >= 0 ? { strength: cn.strength } : {})
        }
      }
    }

    const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const userMsg: ChatMessage = {
      id: messageId,
      role: 'user',
      text: req.prompt,
      // display-only: both channels land in the persisted user message
      refs: [...refs, ...inputImages],
      // display-only: the video-era channels ride the persisted user message
      ...(audioPath ? { audioPath } : {}),
      ...(controlVideoPath ? { controlVideoPath } : {}),
      ...(endImagePath ? { endImagePath } : {}),
      ...(audioRefPaths.length ? { audioReferencePaths: audioRefPaths } : {}),
      ...(videoRefPaths.length ? { videoReferencePaths: videoRefPaths } : {}),
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

    // vid_gen runs produce a Motion-JPEG .avi — the bundled runtime has no
    // ffmpeg muxer and man.txt lists ".avi, .webm, and animated .webp" as the
    // single-file video outputs. Requesting .mp4 makes sd-cli APPEND .avi to
    // the path (name.mp4.avi) while the app probes the missing .mp4 file.
    const output = newOutputPath(req.sessionId, assistantMsg.id, req.genMode === 'vid_gen' ? 'avi' : 'png')
    const paths = {
      model: modelPath,
      modelBehavior,
      // WAN MoE companion — emitted as --high-noise-diffusion-model (its
      // presence also gates the three --high-noise-* sampling flags).
      highNoiseModel: highNoisePath,
      // Unified companion arrays — one { path, useAs } per companion file;
      // buildArgs emits one --<useAs> <path> per item (VAE skipped for
      // all_in_one types; the latent upscaler stays upscale-gated).
      vae: vaeRes.resolved,
      encoder: encoderPaths,
      vision: visionRes.resolved,
      tokenizer: tokenizerRes.resolved,
      // Wan2.2 S2V audio encoder (--audio-encoder)
      audioEncoder: audioEncoderRes.resolved,
      // LTX 2.5 audio VAE (--audio-vae)
      audioVae: audioVaeRes.resolved,
      // LTX 2.5 latent upscaler — buildArgs derives --hires-upscalers-dir +
      // --hires-upscaler from each absolute path (only when upscale is on)
      latentUpscaler: latentUpscalerRes.resolved,
      // Per-session LoRA flags; undefined when the session's mode is 'off'
      // (or unset) — buildArgs emits neither flag then.
      lora: loraSpawn,
      // ADetailer (YOLOv8 object detector repair pass); undefined when the
      // session's adetailer is disabled or no model is selected — buildArgs
      // emits neither --ad-model nor --extra-ad-args then.
      adetailer: adetailerSpawn,
      // IP Adapter; undefined when the session's apply switch is off — buildArgs
      // emits --clip_vision + --ip-adapter + --ip-adapter-image + (optional)
      // --ip-adapter-strength when set.
      ipAdapter: ipAdapterSpawn,
      // Control Net; undefined when the session's apply switch is off — buildArgs
      // emits --control-net + --control-image + (optional) --control-strength.
      controlNet: controlNetSpawn,
      initImage,
      // inpaint/outpaint mask — always set together with initImage (main
      // never emits --mask without --init-img)
      mask: maskPath,
      references: existingRefs,
      // Video-era channels (undefined for types that forbid them)
      audioPath,
      controlVideoPath,
      endImagePath,
      // Repeatable reference channels (empty arrays for types that forbid them)
      audioReferencePaths: audioRefPaths,
      videoReferencePaths: videoRefPaths,
      output
    }

    // Apply the global performance settings (Flash Attention, VAE tiling,
    // CPU offload, params backend, ...) to this generation, but only when the
    // user has explicitly enabled the performance profile in settings.json.
    const perf = settings.get().performance
    if (perf?.enabled) req.performance = perf

    // Capture the spawn timestamp so the terminal 'done' event can report the
    // total wall-clock generation time (spawn → done, incl. any ffmpeg
    // conversion) on the image preview badge.
    const genStart = Date.now()
    const gen = sdcli.generate(binary, req, paths, {
      onProgress: (step, totalSteps) =>
        sendProgress(req.sessionId, assistantMsg.id, { status: 'running', step, totalSteps }),
      onDone: (imagePath) => {
        // vid_gen outputs are Motion-JPEG .avi (the bundled runtime has no
        // ffmpeg muxer) — Chromium cannot play MJPEG inline, so every .avi
        // is re-encoded to H.264 .mp4 via the bundled ffmpeg before being
        // reported. The original .avi is deleted on success (only .mp4 stays
        // on disk); on failure the .avi is kept and reported as-is — the
        // legacy poster-frame path in ImageFromPath.vue still renders it.
        // Non-.avi outputs (images, .webm) are untouched.
        const finish = async (): Promise<void> => {
          let finalPath = imagePath
          if (imagePath.toLowerCase().endsWith('.avi')) {
            // Track the phase on the live entry so gen:state reports the
            // session as converting (the "Converting…" label survives a
            // session switch — plans/session-switch-busy-state.md).
            const live = activeGens.get(req.sessionId)
            if (live) live.converting = true
            sendProgress(req.sessionId, assistantMsg.id, { status: 'converting' })
            try {
              // Lazy fallback: when the init-pipeline download failed
              // (offline / mirror down), the first conversion retries it —
              // download progress rides the same 'converting' event.
              await ensureFfmpeg((downloadedBytes, totalBytes) => {
                sendProgress(req.sessionId, assistantMsg.id, {
                  status: 'converting',
                  step: Math.round((downloadedBytes / Math.max(totalBytes, 1)) * 100)
                })
              })
              const mp4Path = await convertToMp4(imagePath)
              // Debug aid: set MYRIAD_KEEP_AVI (any value) to retain the raw
              // Motion-JPEG .avi next to the .mp4 so it can be inspected — the
              // raw stream is what the re-encoded .mp4 is derived from, so it
              // is the first thing to check when a video comes out wrong.
              if (!process.env.MYRIAD_KEEP_AVI) {
                rmSync(imagePath, { force: true })
              }
              finalPath = mp4Path
            } catch (e) {
              // Keep the .avi on disk and report it as done — the poster
              // fallback keeps it viewable. Full detail lands in the log.
              log.error(`[gen] avi→mp4 conversion failed (session ${req.sessionId}): ${(e as Error).message}`)
            }
            }
            // Total generation time from spawn to done (incl. any ffmpeg
            // conversion) — persisted on the message so the renderer shows it
            // on the image preview badge after refreshActive() reloads it.
            const durationMs = Date.now() - genStart
            sessions.updateMessage(req.sessionId, assistantMsg.id, {
              image: { path: finalPath, name: basename(finalPath), durationMs },
              status: 'ok'
            })
            // Terminal: the entry is dropped only AFTER the work — it stays
            // resolvable via gen:state / gen:isRunning for the whole busy
            // lifetime, through the conversion phase (the child process itself
            // has already exited; gen:stop ignores it via the exit guard).
            activeGens.delete(req.sessionId)
            sendProgress(req.sessionId, assistantMsg.id, {
              status: 'done',
              image: { path: finalPath, name: basename(finalPath) },
              durationMs
            })
        }
        void finish()
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
    // During the post-generation conversion phase the child has already
    // exited while the entry stays alive (gen:state accuracy) — stopping
    // then must be a no-op, never a spurious 'stopped' event mid-conversion.
    if (entry.gen.child.exitCode !== null || entry.gen.child.signalCode !== null) return
    sdcli.stop(entry.gen)
    sessions.updateMessage(entry.sessionId, entry.messageId, { status: 'stopped' })
    sendProgress(entry.sessionId, entry.messageId, { status: 'stopped' })
    activeGens.delete(sessionId)
  })

  ipcMain.handle('gen:isRunning', (_e, sessionId: string): boolean => activeGens.has(sessionId))

  // Full in-flight probe for rehydration (plans/session-switch-busy-state.md):
  // the renderer mirrors the busy state back after a session switch / dev
  // reload — `running` alone can't distinguish the conversion phase, which
  // needs the "Converting…" label instead of the step counter.
  ipcMain.handle('gen:state', (_e, sessionId: string): GenStateInfo => {
    const entry = activeGens.get(sessionId)
    return {
      running: !!entry,
      converting: entry?.converting ?? false,
      ...(entry ? { messageId: entry.messageId } : {})
    }
  })

  // ---------- upscale (image upscaler) ----------
  // One upscale at a time (the single-flight guard in upscaler.ts). The
  // session is captured at invoke time so a session switch mid-run appends
  // the result to the right session. No push events: the renderer awaits the
  // invoke with an indeterminate busy overlay.
  ipcMain.handle('upscale:start', async (_e, req: UpscaleRequest): Promise<UpscaleResult> => {
    const cfg = loadAllConfigs()
    const st = settings.get()
    const version = st.runtimeVersion ?? Object.keys(cfg.runtime.releases).sort((a, b) => Number(b) - Number(a))[0]
    const binary = runtime.binaryFor(version)
    if (!binary) {
      throw new Error(`Runtime ${version} is not installed. Download it in Settings → Runtime.`)
    }
    if (!req.path || !existsSync(req.path)) {
      throw new Error('Source image not found — it may have been deleted.')
    }
    const modelPath = models.pathFor(
      'pixel_upscaler',
      req.model,
      req.provider,
      req.diffusionType,
      expectUrlFor('pixel_upscaler', req.diffusionType ?? '', req.provider, req.model)
    )
    if (!existsSync(modelPath)) {
      throw new Error(`Upscaler model not found: ${req.model}. Download it in Settings → Upscaler.`)
    }
    const tileSize = normalizeTileSize(req.tileSize)
    const outputPath = upscaleOutputPath(req.path)
    try {
      await runUpscale({ binary, imagePath: req.path, modelPath, outputPath, tileSize })
    } catch (err) {
      throw new Error(`Upscale failed: ${(err as Error).message}`)
    }
    const name = basename(outputPath)
    // Append the result to the session as a NEW assistant message (the same
    // persistence path as generation) — the original message is untouched.
    sessions.addMessage(req.sessionId, {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      role: 'assistant',
      text: '',
      image: { path: outputPath, name },
      status: 'ok',
      createdAt: Date.now()
    })
    return { path: outputPath, name }
  })

  // ---------- llm (prompt enhancer) ----------
  // One enhancement at a time (module state inside llm.ts); a second click on
  // the Enhance button routes through llm:stop (the Send→Stop pattern).
  ipcMain.handle('llm:enhance', async (_e, prompt: string): Promise<LlmEnhanceResult> => {
    const result = await enhancePrompt(typeof prompt === 'string' ? prompt : '')
    return { text: result.text }
  })

  ipcMain.handle('llm:stop', (): void => {
    stopActiveEnhance()
  })

  ipcMain.handle('llm:status', (): LlmStatusInfo => {
    const platformKey = getInitState().platform?.llmRuntimeKey
    const st = llmStatus(platformKey)
    return {
      version: st.version,
      installed: st.installed,
      platformKey: st.platformKey,
      modelInstalled: defaultModelInstalled()
    }
  })

  // Manual (re)install of the llama.cpp runtime — awaits ensureLlmRuntime and
  // streams llm:progress to all windows (the runtime:progress pattern).
  ipcMain.handle('llm:installRuntime', async (): Promise<string> => {
    const platformKey = getInitState().platform?.llmRuntimeKey
    return ensureLlmRuntime(platformKey, (p) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('llm:progress', p)
      }
    })
  })

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
    'models/audio_encoder',
    'models/lora',
    'output',
    'sessions',
    'cache',
    'runtime',
    // bundled ffmpeg binary (downloaded once per machine by the init pipeline;
    // lives outside data/tmp so it survives the per-launch wipe + app updates)
    'bin/ffmpeg',
    // llama.cpp LLM runtime (the prompt enhancer; same outside-tmp lifecycle)
    'bin/llm',
    'logs'
  ]) {
    mkdirSync(join(root, d), { recursive: true })
  }
  // `data/tmp` holds staged downloads (models + runtime zips + the ffmpeg
  // archive) before they are moved to their live destination. Wiped as a full
  // clean slate on every launch so an interrupted download never leaves a
  // partial file behind — a fresh full re-download is always performed. The
  // wipe happens before startAllPending() (fired from index.ts after
  // registerIpc()) so background retries start clean.
  mkdirSync(join(root, 'tmp'), { recursive: true })
  rmSync(join(root, 'tmp'), { recursive: true, force: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  mkdirSync(join(root, 'tmp', 'ffmpeg'), { recursive: true })
  mkdirSync(join(root, 'tmp', 'llm'), { recursive: true })
  ensureModelDirs()
}

