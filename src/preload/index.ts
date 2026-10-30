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
  DownloadEntry,
  DownloadProgress,
  DownloadsListResult,
  GenProgress,
  GenerationRequest,
  HubCatalog,
  HubCheckResult,
  InitState,
  InitStatus,
  LogLevel,
  LogsInfo,
  ModelFile,
  ModelType,
  PlatformInfo,
  ResolutionEntry,
  RuntimeCheckResult,
  RuntimeKey,
  RuntimeVersionInfo,
  Session,
  SessionInputs,
  Settings,
  ThemeKey
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
  /** Resolves the absolute saved file path, or null when canceled/failed. */
  saveImage: (p: string): Promise<string | null> => ipcRenderer.invoke('app:saveImage', p),
  /** Reveal the file in the OS file manager (selects the file). */
  showInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('app:showInFolder', p),

  // runtime
  runtimeVersions: (): Promise<RuntimeVersionInfo[]> => ipcRenderer.invoke('runtime:versions'),
  /**
   * Resolves `true` when the download completes, `false` when Pause/Cancel
   * aborted it (expected — not an error, so the invoke never rejects for it).
   */
  runtimeDownload: (version: string, key: RuntimeKey): Promise<boolean> =>
    ipcRenderer.invoke('runtime:download', version, key),
  /** Fetch the remote runtime config; writes the override when it differs. */
  runtimeCheckUpdates: (): Promise<RuntimeCheckResult> =>
    ipcRenderer.invoke('runtime:checkUpdates'),
  /** Delete the runtime config override so the bundled config becomes active. */
  runtimeResetConfig: (): Promise<void> => ipcRenderer.invoke('runtime:resetConfig'),

  // hub
  hubCatalog: (): Promise<HubCatalog | null> => ipcRenderer.invoke('hub:catalog'),
  hubRefresh: (): Promise<HubCatalog> => ipcRenderer.invoke('hub:refresh'),
  /** Fetch the remote hub config; writes the override when it differs. */
  hubCheckUpdates: (): Promise<HubCheckResult> => ipcRenderer.invoke('hub:checkUpdates'),
  /** Delete the hub config override so the bundled config becomes active. */
  hubResetConfig: (): Promise<void> => ipcRenderer.invoke('hub:resetConfig'),

  // models
  modelsList: (type: ModelType): Promise<ModelFile[]> => ipcRenderer.invoke('models:list', type),
  /**
   * Resolves the destination path on success. When Pause/Cancel aborts the
   * download (expected — not an error), resolves the '' sentinel instead of
   * rejecting; the settings store rethrows DOWNLOAD_ABORTED_MESSAGE for it.
   */
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

  // downloads registry
  downloadsList: (): Promise<DownloadsListResult> => ipcRenderer.invoke('downloads:list'),
  /**
   * Cancel or remove a download. `arg` is either a runtime version (short
   * numeric string) or a model download URL (full http(s)://). The manager
   * validates the value against both namespaces and throws if it matches
   * neither, so a future bad value fails loudly.
   */
  downloadsCancel: (arg: string): Promise<void> => ipcRenderer.invoke('downloads:cancel', arg),
  downloadsSetPaused: (paused: boolean): Promise<void> => ipcRenderer.invoke('downloads:setPaused', paused),

  // settings
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  settingsSave: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:save', patch),

  // theme: persists the selection in main, broadcasts the change back so the
  // renderer applies it live (preload can't reach the renderer's Pinia store —
  // they're isolated contexts — so this goes through IPC).
  setTheme: (key: ThemeKey): Promise<void> => ipcRenderer.invoke('theme:set', key),
  onThemeChange: (cb: (key: ThemeKey) => void): void => {
    ipcRenderer.on('theme:changed', (_e, key: ThemeKey) => cb(key))
  },

  // logs
  /** Read the tail of data/logs/latest.log (Settings → Logs, read on demand). */
  logsGet: (): Promise<LogsInfo> => ipcRenderer.invoke('logs:get'),
  /**
   * Fire-and-forget renderer console forwarding (installed in renderer
   * main.ts). `send`, not `invoke` — no response is needed and per-call
   * request/response overhead is unnecessary for chatty renderer output.
   */
  logsForward: (level: LogLevel, args: unknown[]): void =>
    ipcRenderer.send('logs:forward', level, args),

  // sessions
  sessionsList: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
  sessionsGet: (id: string): Promise<Session | null> => ipcRenderer.invoke('sessions:get', id),
  sessionsCreate: (name?: string): Promise<Session> => ipcRenderer.invoke('sessions:create', name),
  sessionsRename: (id: string, name: string): Promise<Session> => ipcRenderer.invoke('sessions:rename', id, name),
  sessionsRemove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id),
  sessionsRemoveMessage: (id: string, messageId: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:removeMessage', id, messageId),
  sessionsSetInputs: (id: string, patch: SessionInputs): Promise<Session> =>
    ipcRenderer.invoke('sessions:setInputs', id, patch),

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
    ipcRenderer.on('hub:progress', (_e, p: { message: string }) => cb(p))
  },
  onDownloadsChanged: (cb: (p: DownloadsListResult) => void): void => {
    ipcRenderer.on('downloads:changed', (_e, p: DownloadsListResult) => cb(p))
  }
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)

export type { ChatMessage, DownloadEntry }
