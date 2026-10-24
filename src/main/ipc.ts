/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  AllConfigs,
  ChatMessage,
  DownloadProgress,
  GenProgress,
  GenerationRequest,
  HubCatalog,
  ModelFile,
  ModelType,
  PlatformInfo,
  ResolutionEntry,
  RuntimeKey,
  RuntimeVersionInfo,
  SamplingDefaults,
  Session,
  Settings
} from '@shared/types'
import { loadAllConfigs } from './services/config'
import { headSize } from './services/download'
import { createHubService } from './services/hub'
import { getInitState } from './services/init'
import { createModelsService, ensureModelDirs } from './services/models'
import { detectPlatform } from './services/platform'
import { createRuntimeService } from './services/runtime'
import { createSessionsService } from './services/sessions'
import { createSettingsService } from './services/settings'
import { createSdCliService, newOutputPath } from './services/sdcli'

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
    max_reference: 0,
    steps: 25,
    cfg: 1.0,
    sampler: 'euler',
    width: 1024,
    height: 1024
  }
  const override = settings.get().sampling?.[diffusionType] ?? {}
  return { ...base, ...override }
}

export function registerIpc(): void {
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
    const hubCfg = loadAllConfigs().hub
    return {
      name: hubCfg.label,
      version: app.getVersion(),
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

  ipcMain.handle('app:saveImage', async (_e, imagePath: string): Promise<boolean> => {
    if (!existsSync(imagePath)) return false
    const win = BrowserWindow.getFocusedWindow?.() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Image',
      defaultPath: basename(imagePath),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      buttonLabel: 'Save'
    })
    if (res.canceled || res.filePath === '') return false
    const fs = await import('node:fs')
    await fs.promises.copyFile(imagePath, res.filePath)
    return true
  })

  // ---------- runtime ----------
  ipcMain.handle('runtime:versions', (): RuntimeVersionInfo[] => runtime.versions())

  ipcMain.handle(
    'runtime:download',
    async (_e, version: string, key: RuntimeKey): Promise<void> => {
      await runtime.download(version, key, (p: DownloadProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('runtime:progress', { version, ...p })
        }
      })
    }
  )

  // ---------- hub ----------
  ipcMain.handle('hub:catalog', (): HubCatalog | null => hub.get())

  ipcMain.handle('hub:refresh', async (): Promise<HubCatalog> => {
    return hub.refresh((msg) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('hub:progress', { message: msg })
      }
    })
  })

  // ---------- models ----------
  ipcMain.handle('models:list', (_e, type: ModelType): ModelFile[] => models.list(type))

  ipcMain.handle(
    'models:download',
    async (_e, type: ModelType, url: string, provider?: string, force?: boolean): Promise<string> => {
      return models.download(type, url, (downloadedBytes, totalBytes) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('models:progress', { type, url, downloadedBytes, totalBytes })
        }
      }, provider, force)
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

  // ---------- generation ----------
  ipcMain.handle('gen:start', async (_e, req: GenerationRequest): Promise<string> => {
    const cfg = loadAllConfigs()
    const sampling = effectiveSampling(req.diffusionType, cfg)

    const st = settings.get()
    const version = st.runtimeVersion ?? Object.keys(cfg.runtime).sort((a, b) => Number(b) - Number(a))[0]
    const binary = runtime.binaryFor(version)
    if (!binary) {
      throw new Error(`Runtime ${version} is not installed. Download it in Settings → Runtime.`)
    }

    const modelPath = models.pathFor('diffusion', req.model)
    if (!existsSync(modelPath)) throw new Error(`Diffusion model not found: ${req.model}`)
    const vaePath = req.vae ? models.pathFor('vae', req.vae) : undefined
    if (req.vae && vaePath && !existsSync(vaePath)) throw new Error(`VAE not found: ${req.vae}`)
    const encoderPath = req.encoder ? models.pathFor('encoder', req.encoder) : undefined
    if (req.encoder && encoderPath && !existsSync(encoderPath)) {
      throw new Error(`Encoder not found: ${req.encoder}`)
    }
    const visionPath = req.vision ? models.pathFor('vision', req.vision) : undefined
    if (req.vision && visionPath && !existsSync(visionPath)) {
      throw new Error(`Vision model not found: ${req.vision}`)
    }

    const refs = [...req.referencePaths]
    if (req.usePrevious && req.previousImagePath && existsSync(req.previousImagePath)) {
      if (!refs.includes(req.previousImagePath)) refs.push(req.previousImagePath)
    }
    if (refs.length > sampling.max_reference) refs.length = sampling.max_reference

    const session = sessions.get(req.sessionId)
    if (!session) throw new Error(`Session ${req.sessionId} not found`)
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
      vae: vaePath,
      encoder: encoderPath,
      vision: visionPath,
      references: refs.filter((r) => existsSync(r)),
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
    'runtime'
  ]) {
    mkdirSync(join(root, d), { recursive: true })
  }
  ensureModelDirs()
}
