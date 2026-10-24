/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { initDataDirs, registerIpc } from './ipc'
import { loadRuntimeConfig } from './services/config'
import { createHubService } from './services/hub'
import { setInitState } from './services/init'
import { detectPlatform } from './services/platform'
import { createRuntimeService } from './services/runtime'
import { createSettingsService } from './services/settings'
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
    title: 'Myriad Frame',
    backgroundColor: '#0f1115',
    // Hide the default application menu (Edit, View, Window, Help).
    menu: null,
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
        await runtime.download(selected, platform.runtimeKey, (p) => {
          status({
            stage: 'runtime',
            message: `${p.phase === 'extracting' ? 'Extracting' : 'Downloading'} runtime ${selected}… ${Math.round((p.downloadedBytes / Math.max(p.totalBytes, 1)) * 100)}%`,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
            phase: p.phase
          })
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

app.whenReady().then(async () => {
  initDataDirs()
  registerIpc()
  createWindow()
  if (mainWindow) void runInitPipeline(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
