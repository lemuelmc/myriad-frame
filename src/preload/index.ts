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

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AllConfigs,
  ChatMessage,
  DownloadProgress,
  GenProgress,
  GenerationRequest,
  HubCatalog,
  InitState,
  InitStatus,
  ModelFile,
  ModelType,
  PlatformInfo,
  ResolutionEntry,
  RuntimeKey,
  RuntimeVersionInfo,
  Session,
  Settings
} from '@shared/types'

export interface AboutInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
}

const api = {
  // app
  configs: (): Promise<AllConfigs> => ipcRenderer.invoke('app:configs'),
  /** Full init state; lets the renderer catch up on init events it missed. */
  initState: (): Promise<InitState> => ipcRenderer.invoke('app:initState'),
  platform: (): Promise<PlatformInfo> => ipcRenderer.invoke('app:platform'),
  resolutions: (diffusionType: string): Promise<ResolutionEntry[]> =>
    ipcRenderer.invoke('app:resolutions', diffusionType),
  about: (): Promise<AboutInfo> => ipcRenderer.invoke('app:about'),
  pickImages: (): Promise<string[]> => ipcRenderer.invoke('app:pickImages'),
  imageFromPath: (p: string): Promise<string> => ipcRenderer.invoke('app:imageFromPath', p),
  saveImage: (p: string): Promise<boolean> => ipcRenderer.invoke('app:saveImage', p),

  // runtime
  runtimeVersions: (): Promise<RuntimeVersionInfo[]> => ipcRenderer.invoke('runtime:versions'),
  runtimeDownload: (version: string, key: RuntimeKey): Promise<void> =>
    ipcRenderer.invoke('runtime:download', version, key),

  // hub
  hubCatalog: (): Promise<HubCatalog | null> => ipcRenderer.invoke('hub:catalog'),
  hubRefresh: (): Promise<HubCatalog> => ipcRenderer.invoke('hub:refresh'),

  // models
  modelsList: (type: ModelType): Promise<ModelFile[]> => ipcRenderer.invoke('models:list', type),
  modelsDownload: (
    type: ModelType,
    url: string,
    provider?: string,
    force?: boolean
  ): Promise<string> =>
    ipcRenderer.invoke('models:download', type, url, provider, force),
  modelsRemove: (type: ModelType, name: string): Promise<void> =>
    ipcRenderer.invoke('models:remove', type, name),
  modelsVerify: (
    type: ModelType,
    name: string,
    url: string
  ): Promise<{ ok: boolean; actual: number; expected: number }> =>
    ipcRenderer.invoke('models:verify', type, name, url),

  // settings
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  settingsSave: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:save', patch),

  // sessions
  sessionsList: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
  sessionsGet: (id: string): Promise<Session | null> => ipcRenderer.invoke('sessions:get', id),
  sessionsCreate: (name?: string): Promise<Session> => ipcRenderer.invoke('sessions:create', name),
  sessionsRename: (id: string, name: string): Promise<Session> => ipcRenderer.invoke('sessions:rename', id, name),
  sessionsRemove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id),
  sessionsRemoveMessage: (id: string, messageId: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:removeMessage', id, messageId),

  // generation
  genStart: (req: GenerationRequest): Promise<string> => ipcRenderer.invoke('gen:start', req),
  genStop: (sessionId: string): Promise<void> => ipcRenderer.invoke('gen:stop', sessionId),
  genIsRunning: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('gen:isRunning', sessionId),

  // events (main -> renderer)
  onInitStatus: (cb: (s: InitStatus) => void): void => {
    ipcRenderer.on('init:status', (_e, s: InitStatus) => cb(s))
  },
  onAppReady: (cb: (p: { platform?: PlatformInfo }) => void): void => {
    ipcRenderer.on('app:ready', (_e, p) => cb(p))
  },
  onGenProgress: (cb: (p: GenProgress) => void): void => {
    ipcRenderer.on('gen:progress', (_e, p: GenProgress) => cb(p))
  },
  onRuntimeProgress: (cb: (p: { version: string } & DownloadProgress) => void): void => {
    ipcRenderer.on('runtime:progress', (_e, p) => cb(p))
  },
  onModelsProgress: (cb: (p: { type: ModelType; url: string } & DownloadProgress) => void): void => {
    ipcRenderer.on('models:progress', (_e, p) => cb(p))
  },
  onHubProgress: (cb: (p: { message: string }) => void): void => {
    ipcRenderer.on('hub:progress', (_e, p) => cb(p))
  }
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)

export type { ChatMessage }
