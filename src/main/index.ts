/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app, BrowserWindow, Menu, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSessionCompanionDownloads, initDataDirs, registerIpc } from './ipc'
import { loadApplicationConfig, loadHubConfig, loadRuntimeConfig } from './services/config'
import { ensureFfmpeg } from './services/ffmpeg'
import { catalogEntriesForType, createHubService } from './services/hub'
import { setInitState } from './services/init'
import { stopActiveEnhance } from './services/llm'
import { ensureLlmRuntime } from './services/llm-runtime'
import { initLogging } from './services/logging'
import { registerMediaProtocol } from './services/media'
import { createModelsService, migrateModelLayout } from './services/models'
import { detectPlatform } from './services/platform'
import { createRuntimeService } from './services/runtime'
import { createSettingsService } from './services/settings'
import { checkForAppUpdate, checkForConfigUpdates } from './services/updates'
import { listModels, startAllPending } from './services/downloads'
import type { HubPixelUpscalerEntry, InitStatus, PlatformInfo } from '@shared/types'
import type { HubService } from './services/hub'

// Disable GPU compositing. Without this, resizing the window while the main
// process is busy (e.g. streaming model/runtime downloads) can leave the
// renderer contents clipped or not repainted to the new bounds: the GPU
// compositing thread is starved and fails to re-rasterize the composited layer
// on resize. Software rendering repaints synchronously with the resize. Must be
// set before `app.whenReady()` to take effect.
app.commandLine.appendSwitch('disable-gpu', '')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    // Window title derives from application.json (app identity config).
    title: loadApplicationConfig().label,
    backgroundColor: '#0f1115',
    // App icon. Resolves to the bundled logo in dev (src/main) and packaged
    // builds (out/main); falls back to Electron's default when the asset is
    // missing so the window still launches.
    icon: join(__dirname, '../assets/logo-square-small.png'),
    // Default application menu (Edit, View, Window, Help) is enabled by omitting `menu`.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Hide the default application menu (Edit, View, Window, Help).
Menu.setApplicationMenu(null)

/**
 * Init pipeline: platform detection -> ensure runtime installed ->
 * ensure hub catalog cached. Progress is streamed to the renderer so it
 * can show the "Initializing" overlay.
 *
 * Every status update is also mirrored into shared init state: the pipeline
 * can finish before the renderer has mounted and registered its event
 * listeners (e.g. a cached catalog makes it near-instant), in which case
 * live events are lost. The renderer pulls the state on mount to catch up.
 */
async function runInitPipeline(win: BrowserWindow): Promise<void> {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const status = (payload: InitStatus): void => {
    setInitState(payload)
    send('init:status', payload)
  }

  status({ stage: 'platform', message: 'Detecting platform…' })
  const platform = await detectPlatform()
  status({ stage: 'platform', message: `Platform: ${platform.os} (${platform.runtimeKey})`, platform })

  const settings = createSettingsService()
  const runtime = createRuntimeService()
  const hub = createHubService()

  // 1. ensure the selected runtime version is installed
  const versions = runtime.versions()
  const latest = versions[0]?.version
  const selected = settings.get().runtimeVersion ?? latest
  const info = versions.find((v) => v.version === selected)
  if (info && !info.installed && !info.downloading && latest) {
    const url = loadRuntimeConfig().releases[selected]?.[platform.runtimeKey]
    if (url) {
      status({ stage: 'runtime', message: `Downloading runtime ${selected} (${platform.runtimeKey})…` })
      try {
        // Throttle the per-chunk progress status: runtime.download reports on
        // every HTTP data chunk, and one init:status IPC per chunk floods the
        // renderer's main thread (sluggish resize/UI while the first-launch
        // runtime download streams). Phase changes bypass the throttle so the
        // "Extracting…" state is never swallowed.
        let lastStatusAt = 0
        let lastPhase: string | undefined
        await runtime.download(selected, platform.runtimeKey, (p) => {
          const phase = p.phase ?? 'downloading'
          const now = Date.now()
          if (phase !== lastPhase || now - lastStatusAt >= 100) {
            lastPhase = phase
            lastStatusAt = now
            status({
              stage: 'runtime',
              message: `${phase === 'extracting' ? 'Extracting' : 'Downloading'} runtime ${selected}… ${Math.round((p.downloadedBytes / Math.max(p.totalBytes, 1)) * 100)}%`,
              downloadedBytes: p.downloadedBytes,
              totalBytes: p.totalBytes,
              phase: p.phase
            })
          }
        })
        status({ stage: 'runtime', message: `Runtime ${selected} ready` })
      } catch (e) {
        // non-fatal: user can retry from Settings → Runtime
        status({ stage: 'runtime', message: `Runtime download failed: ${(e as Error).message}` })
      }
    }
  }

  // 2. ensure the bundled ffmpeg binary is installed (vid_gen .avi → .mp4
  //    conversion). Downloaded once per machine into data/bin/ffmpeg/ — a
  //    no-op (one existsSync) once present. Non-fatal: the conversion path's
  //    lazy ensureFfmpeg() retries on first use. Placed after the runtime
  //    step (so the largest first-launch transfer is not competing) and
  //    before app:ready (so the first video conversion never stalls on a
  //    download).
  status({ stage: 'ffmpeg', message: 'Downloading ffmpeg…' })
  try {
    await ensureFfmpeg((downloadedBytes, totalBytes) => {
      status({
        stage: 'ffmpeg',
        message: `Downloading ffmpeg… ${Math.round((downloadedBytes / Math.max(totalBytes, 1)) * 100)}%`,
        downloadedBytes,
        totalBytes,
        phase: 'downloading'
      })
    })
    status({ stage: 'ffmpeg', message: 'ffmpeg ready' })
  } catch (e) {
    // non-fatal: the first video conversion retries the download lazily
    status({ stage: 'ffmpeg', message: `ffmpeg download failed: ${(e as Error).message}` })
  }

  // 2.5 ensure the llama.cpp LLM runtime is installed (the prompt enhancer).
  // Same outside-tmp lifecycle as ffmpeg: downloaded once per machine into
  // data/bin/llm/, a cheap existsSync on every launch afterwards. Non-fatal:
  // the enhance path retries the download lazily on first use. Placed after
  // the ffmpeg step (the two largest first-launch transfers do not compete)
  // and before the catalog step.
  if (!platform.llmRuntimeKey) {
    status({ stage: 'llm', message: 'No LLM runtime for this platform (Enhance disabled)' })
  } else {
    status({ stage: 'llm', message: 'Checking LLM runtime…' })
    try {
      // Throttled per-chunk progress (the runtime-step pattern — one
      // init:status IPC per HTTP chunk would flood the renderer).
      let lastStatusAt = 0
      let lastPhase: string | undefined
      await ensureLlmRuntime(platform.llmRuntimeKey, (p) => {
        const phase = p.phase ?? 'downloading'
        const now = Date.now()
        if (phase !== lastPhase || now - lastStatusAt >= 100) {
          lastPhase = phase
          lastStatusAt = now
          status({
            stage: 'llm',
            message: `${phase === 'extracting' ? 'Extracting' : 'Downloading'} LLM runtime… ${Math.round((p.downloadedBytes / Math.max(p.totalBytes, 1)) * 100)}%`,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
            phase: p.phase
          })
        }
      })
      status({ stage: 'llm', message: 'LLM runtime ready' })
    } catch (e) {
      // non-fatal: the enhance path retries the download lazily
      status({ stage: 'llm', message: `LLM runtime download failed: ${(e as Error).message}` })
    }
  }

  // 3. ensure the hub catalog cache exists (scan only when missing)
  if (!hub.get()) {
    status({ stage: 'catalog', message: 'Scanning model hub…' })
    try {
      await hub.refresh((msg) => status({ stage: 'catalog', message: msg }))
      status({ stage: 'catalog', message: 'Model hub catalog ready' })
    } catch (e) {
      status({ stage: 'catalog', message: `Hub scan failed: ${(e as Error).message}` })
    }
  }

  setInitState({ ready: true, stage: 'done', message: 'Ready' })
  send('app:ready', { platform })

  // 3. launch-time config update check (detect-only): fetch the remote
  // hub.json / runtime.json and toast the renderer when either differs from
  // the active config. Fire-and-forget AFTER app:ready so it can never delay
  // readiness or toast under the InitOverlay; failures are swallowed inside
  // the orchestrator (an offline launch must not nag — the manual Settings
  // → Check buttons surface errors). The notify callback broadcasts
  // `updates:available` to all windows; each send is guarded like `send`
  // above so a fast-closed window cannot crash the check.
  void checkForConfigUpdates((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('updates:available', status)
    }
  })

  // 3b. launch-time app-version check (detect-only): fetch the remote
  // application.json and toast the renderer when its version is strictly
  // greater than the bundled one. Fire-and-forget AFTER app:ready so it can
  // never delay readiness or toast under the InitOverlay; failures are
  // swallowed inside the check (an offline launch must not nag). The notify
  // callback broadcasts `app:available` to all windows; each send is guarded
  // like `send` above so a fast-closed window cannot crash the check.
  void checkForAppUpdate((available) => {
    if (!available) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:available', available)
    }
  })

  // 4. background default-model ensure (fire-and-forget, non-fatal): when no
  // 'llm' model is installed, none is pending, and the platform HAS an LLM
  // runtime key, resolve the hub default entry from the cached catalog (the
  // catalog step above already ensured the cache) and download it in the
  // background — progress lands in the Downloads panel via models:progress.
  // Never blocks the InitOverlay; the Enhance button errors gracefully with a
  // pointer to Settings until the model lands.
  void ensureDefaultLlmModel(hub, platform)

  // 5. background default-upscaler ensure (fire-and-forget, non-fatal): when
  // the hub-configured default pixel upscaler file is NOT on disk and not
  // already pending, resolve it from the cached catalog and download it in
  // the background — progress lands in the Downloads panel via
  // models:progress and the sidebar footer indicator animates via the
  // existing downloads:changed wiring. Never blocks the InitOverlay; the
  // Upscale dialog surfaces the missing model through its installed checks.
  void ensureDefaultPixelUpscaler(hub)

  // 6. background default-adetailer ensure (fire-and-forget, non-fatal): when
  // no adetailer model is installed and the hub config declares one, resolve
  // the default entry from the cached catalog and download it in the
  // background — progress lands in the Downloads panel via models:progress.
  void ensureDefaultAdetailerModel(hub)
}

/**
 * Background first-launch download of the hub default language model (the
 * prompt enhancer). Skipped entirely when a model is already installed, a
 * download is already pending, or the platform has no LLM runtime key.
 *
 * Stale-catalog self-heal (existing installs): a catalog cache built before
 * this feature has NO 'llm' rows, so the default entry cannot resolve. When
 * the cache has zero 'llm' entries while `hub.repo.llm.models` is non-empty,
 * run a one-shot `hub.refresh()` first and re-read; only then enqueue the
 * download.
 */
async function ensureDefaultLlmModel(hub: HubService, platform: PlatformInfo): Promise<void> {
  try {
    if (!platform.llmRuntimeKey) return
    const models = createModelsService()
    if (models.list('llm').length > 0) return
    const pending = listModels().some((e) => e.type === 'llm' && e.status !== 'failed')
    if (pending) return
    const hubCfg = loadHubConfig()
    const hasLlmRepos = Object.keys(hubCfg.repo.llm?.models ?? {}).length > 0
    let entries = catalogEntriesForType('llm')
    if (entries.length === 0 && hasLlmRepos) {
      console.log('[llm] catalog cache has no llm entries — rescanning the hub once')
      await hub.refresh()
      entries = catalogEntriesForType('llm')
    }
    if (entries.length === 0) return
    // Resolve the hub default entry: the default.model item (groupId or name
    // match) with the default provider, else a stamped isDefault entry, else
    // the first 'llm' entry.
    const def = hubCfg.repo.llm?.default
    const base = def?.model ? (def.model.split('/').pop() ?? def.model) : undefined
    const entry =
      entries.find(
        (e) =>
          base !== undefined &&
          (e.groupId === def?.model || e.name === base) &&
          (e.provider ?? 'default') === (def?.provider ?? 'default')
      ) ??
      entries.find((e) => e.isDefault) ??
      entries[0]
    console.log(`[llm] background download of the default language model: ${entry.name}`)
    // The manager broadcasts models:progress itself; the callback is a no-op.
    await models.download('llm', entry.url, () => {}, entry.provider)
    console.log(`[llm] default language model downloaded: ${entry.name}`)
  } catch (e) {
    console.warn(`[llm] background default-model download failed: ${(e as Error).message}`)
  }
}

/**
 * First-launch / background default-upscaler ensure (fire-and-forget,
 * non-fatal). When the hub-configured default pixel upscaler file
 * (`repo.pixel_upscaler` → `default`) is NOT on disk and not already
 * pending, resolve it from the cached catalog and download it in the
 * background — progress lands in the Downloads panel via models:progress
 * and the sidebar footer indicator animates via the existing
 * downloads:changed wiring.
 *
 * Deliberately different from ensureDefaultLlmModel() in two ways:
 * 1. SPECIFIC-FILE check: skip only when the SPECIFIC default file exists —
 *    NOT when any pixel_upscaler file is installed. A user who deleted the
 *    default but kept other upscalers must not get it silently re-downloaded
 *    every launch — but the spec says "check if this model exists", so the
 *    exact file is what's checked.
 * 2. Pending check: skip when a download for the default entry's URL is
 *    already in the registry (any status), regardless of type filtering.
 *
 * Stale-catalog self-heal (existing installs): a catalog cache built before
 * this feature has NO 'pixel_upscaler' rows, so the default entry cannot
 * resolve. When the cache has zero 'pixel_upscaler' entries while
 * `hub.repo.pixel_upscaler` is non-empty, run a one-shot `hub.refresh()`
 * first and re-read; only then enqueue the download. This also guarantees
 * the family stamp needed for the family-scoped destination.
 */
async function ensureDefaultPixelUpscaler(hub: HubService): Promise<void> {
  try {
    const models = createModelsService()
    const hubCfg = loadHubConfig()
    const section = hubCfg.repo.pixel_upscaler ?? {}
    const groups = Object.entries(section)
    if (groups.length === 0) return
    // Collect the default entries (one per group entry — the hub default
    // file that MUST be present on first launch).
    const defaults: { entry: HubPixelUpscalerEntry; group: string }[] = []
    for (const [group, ups] of groups) {
      if (!Array.isArray(ups)) continue
      for (const up of ups) {
        if (up === null || typeof up !== 'object' || typeof up.default !== 'string' || up.default === '') continue
        defaults.push({ entry: up, group })
      }
    }
    if (defaults.length === 0) return
    let entries = catalogEntriesForType('pixel_upscaler')
    if (entries.length === 0) {
      console.log('[upscaler] catalog cache has no pixel_upscaler entries — rescanning the hub once')
      await hub.refresh()
      entries = catalogEntriesForType('pixel_upscaler')
    }
    for (const { entry, group } of defaults) {
      const base = entry.default.split('/').pop() ?? entry.default
      const provider = entry.provider ?? 'default'
      // Resolve the catalog entry: the stamped isDefault row for this group,
      // else a name match on the default basename, else a synthetic URL from
      // the hub config (the fallback-entry path in the catalog loop — the
      // URL is the entry's URL, so the registry dedupe still works).
      const catalogEntry =
        entries.find((e) => e.isDefault && e.diffusionType === group && e.name === base) ??
        entries.find((e) => e.diffusionType === group && e.name === base) ??
        entries.find((e) => e.isDefault && e.diffusionType === group)
      if (!catalogEntry) {
        console.warn(`[upscaler] default upscaler "${base}" (${group}) has no catalog entry — skipping`)
        continue
      }
      // SPECIFIC-FILE check: skip only when the exact default file exists at
      // its family-scoped destination (the catalog entry's family/provider).
      const expectUrl = catalogEntry.url
      const expectedPath = models.pathFor('pixel_upscaler', base, provider, group, expectUrl)
      if (existsSync(expectedPath)) continue
      // Pending check: a download for this URL is already in the registry
      // (any status) — the manager's dedupe-by-URL would no-op anyway.
      if (listModels().some((e) => e.url === catalogEntry.url)) continue
      console.log(`[upscaler] background download of the default upscaler model: ${catalogEntry.name}`)
      // The manager broadcasts models:progress itself; the callback is a no-op.
      await models.download('pixel_upscaler', catalogEntry.url, () => {}, provider)
      console.log(`[upscaler] default upscaler model downloaded: ${catalogEntry.name}`)
    }
  } catch (e) {
    console.warn(`[upscaler] background default-upscaler download failed: ${(e as Error).message}`)
  }
}

/**
 * Background first-launch download of the hub default adetailer model. Skipped
 * when a model is already installed or a download is already pending.
 *
 * Stale-catalog self-heal: a catalog cache built before this feature has NO
 * 'adetailer' rows, so the default entry cannot resolve. When the cache has
 * zero 'adetailer' entries while `hub.repo.adetailer` is non-empty, run a
 * one-shot `hub.refresh()` first and re-read; only then enqueue the download.
 */
async function ensureDefaultAdetailerModel(hub: HubService): Promise<void> {
  try {
    const models = createModelsService()
    if (models.list('adetailer').length > 0) return
    const pending = listModels().some((e) => e.type === 'adetailer' && e.status !== 'failed')
    if (pending) return
    const hubCfg = loadHubConfig()
    const adSection = hubCfg.repo.adetailer
    if (!adSection) return
    const hasAdRepos = (adSection.models?.length ?? 0) > 0 || !!adSection.default
    let entries = catalogEntriesForType('adetailer')
    if (entries.length === 0 && hasAdRepos) {
      console.log('[adetailer] catalog cache has no adetailer entries — rescanning the hub once')
      await hub.refresh()
      entries = catalogEntriesForType('adetailer')
    }
    if (entries.length === 0) return
    // Resolve the hub default entry: the default.file item (name match) with
    // the default provider, else a stamped isDefault entry, else the first
    // 'adetailer' entry.
    const def = adSection.default
    const base = def?.file ? (def.file.split('/').pop() ?? def.file) : undefined
    const entry =
      entries.find(
        (e) =>
          base !== undefined &&
          e.name === base &&
          (e.provider ?? 'default') === (def?.provider ?? 'default')
      ) ??
      entries.find((e) => e.isDefault) ??
      entries[0]
    console.log(`[adetailer] background download of the default model: ${entry.name}`)
    // The manager broadcasts models:progress itself; the callback is a no-op.
    await models.download('adetailer', entry.url, () => {}, entry.provider)
    console.log(`[adetailer] default model downloaded: ${entry.name}`)
  } catch (e) {
    console.warn(`[adetailer] background default-model download failed: ${(e as Error).message}`)
  }
}

// Single instance: two app instances share the same userData/data tree — a
// second instance's initDataDirs() wipes data/tmp and clobbers the first
// instance's staged downloads (staged-file ENOENT at rename), and both fight
// over data/downloads.json. The lock turns a second launch into a no-op that
// focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Privileged media:// scheme registration must happen before app ready;
    // the handler installs here (before any window loads) and streams
    // generated videos from data/output with Range support (seekable <video>).
    registerMediaProtocol()
    initDataDirs()
    // Configure electron-log + main console capture before anything else logs.
    // Runs after initDataDirs() so data/logs/ exists, before registerIpc() so
    // the logs:forward bridge logs through the configured logger.
    initLogging()
    registerIpc()
    // One-time-per-launch migration of legacy-depth model files into the
    // family-scoped layout (model-collision-hardening plan §5) — pure
    // renameSync moves, a natural no-op without a catalog cache. Runs AFTER
    // initLogging()/registerIpc() and BEFORE startAllPending()/createWindow():
    // background retries start before the init pipeline, so a migration
    // inside the pipeline would race them, and here no window exists yet (no
    // renderer IPC races) and no retry can recreate a just-moved legacy file.
    migrateModelLayout()
    // Fire background model retries immediately after IPC is wired (the manager's
    // progress broadcasters are installed by registerIpc above, so retries emit
    // progress live). This runs *before* the init pipeline.
    //
    // NOTE: this is intentional first-launch contention. A first launch with a
    // backlog runs up to 2 model downloads concurrently with the uncapped runtime
    // download (3 large transfers total). The model side is already capped at 2,
    // the runtime download stays uncapped and is never queued behind models, so a
    // "yield model retries while the runtime download is in flight" gate would add
    // state for a marginal first-launch benefit.
    void startAllPending()
    // Launch-time dependency self-heal (requires-downloader work): for every
    // session's saved model, kick downloads for requires-declared companion
    // files missing on disk — the resume path for downloads that died without
    // a registry entry (startAllPending above retries the ones that left
    // one). Sync, cheap existsSync probes; the kicks are fire-and-forget and
    // the manager's installed short-circuit keeps them non-redundant.
    ensureSessionCompanionDownloads()
    createWindow()
    if (mainWindow) void runInitPipeline(mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Best-effort kill of an in-flight enhancement on quit (the llm.ts module
// state child would otherwise outlive the window teardown on some platforms).
app.on('before-quit', () => {
  stopActiveEnhance()
})
