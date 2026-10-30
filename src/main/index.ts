/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { initDataDirs, registerIpc } from './ipc'
import { loadApplicationConfig, loadRuntimeConfig } from './services/config'
import { createHubService } from './services/hub'
import { setInitState } from './services/init'
import { initLogging } from './services/logging'
import { detectPlatform } from './services/platform'
import { createRuntimeService } from './services/runtime'
import { createSettingsService } from './services/settings'
import { startAllPending } from './services/downloads'
import type { InitStatus } from '@shared/types'

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
    const url = loadRuntimeConfig()[selected]?.[platform.runtimeKey]
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

  // 2. ensure the hub catalog cache exists (scan only when missing)
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
    initDataDirs()
    // Configure electron-log + main console capture before anything else logs.
    // Runs after initDataDirs() so data/logs/ exists, before registerIpc() so
    // the logs:forward bridge logs through the configured logger.
    initLogging()
    registerIpc()
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
