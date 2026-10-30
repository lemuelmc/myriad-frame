/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'
import type {
  DownloadEntry,
  DownloadProgress,
  DownloadsListResult,
  HubCheckResult,
  ModelFile,
  ModelType,
  PerformanceSettings,
  RuntimeCheckResult,
  RuntimeVersionInfo,
  SamplingDefaults,
  Settings
} from '@shared/types'
import { DOWNLOAD_ABORTED_MESSAGE } from '@shared/types'
import type { ThemeKey } from '@shared/types'
import { applyTheme, assertThemeKey, currentTheme, THEMES } from '../theme'
import { useAppStore } from './app'

export interface ModelDownloadState {
  type: ModelType
  url: string
  downloadedBytes: number
  totalBytes: number
}

export interface RuntimeDownloadState {
  version: string
  downloadedBytes: number
  totalBytes: number
  /** 'downloading' while fetching, 'extracting' while unpacking the runtime archive */
  phase?: 'downloading' | 'extracting'
}

/** Default performance settings; every generation falls back to these. */
export const defaultPerformance: PerformanceSettings = {
  flashAttention: 'off',
  convDirect: 'off',
  vaeTiling: {
    tileSize: 'off',
    overlap: 0.0
  },
  offloadToCpu: 'off',
  paramBackend: 'off',
  paramBackendCustom: ''
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {} as Settings,
    /** Active theme key; source of truth is documentElement data-theme. */
    theme: 'default' as ThemeKey,
    runtimeVersions: [] as RuntimeVersionInfo[],
    runtimeDownloading: null as RuntimeDownloadState | null,
    modelDownloads: {} as Record<string, ModelDownloadState>,
    modelLists: {} as Record<ModelType, ModelFile[]>,
    /** Persisted model-download registry (status only; live progress is in modelDownloads). */
    pendingDownloads: [] as DownloadEntry[],
    /** In-memory pause flag (not persisted; a relaunch resumes normal auto-retry). */
    downloadsPaused: false,
    /** Runtime row from the last `downloads:list` / `downloads:changed` payload. */
    downloadsRuntime: null as {
      version: string
      installed: boolean
      downloading: boolean
      phase?: 'downloading' | 'extracting'
      progress?: { downloadedBytes: number; totalBytes: number }
    } | null
  }),
  getters: {
    selectedVersion(): string | null {
      return this.settings.runtimeVersion ?? this.runtimeVersions[0]?.version ?? null
    },
    performance(): PerformanceSettings {
      // Merge saved overrides onto the defaults so the UI always has a value.
      return {
        ...defaultPerformance,
        ...(this.settings.performance ?? {})
      }
    }
  },
  actions: {
    async load() {
      this.settings = await window.api.settingsGet()
      await this.loadRuntimeVersions()
      try {
        const list = await window.api.downloadsList()
        this.applyDownloadsList(list)
      } catch {
        /* registry unavailable */
      }
    },
    /**
     * Refresh pendingDownloads + downloadsPaused from the manager's list, and
     * prune stale modelDownloads keys: a key is removed when its URL is absent
     * from the refreshed list (completed/removed) or its entry status is
     * 'failed'. Keys for entries still reported 'pending'/'downloading' are
     * kept.
     */
    applyDownloadsList(list: DownloadsListResult): void {
      this.pendingDownloads = list.models
      this.downloadsPaused = list.paused
      this.downloadsRuntime = {
        version: list.runtime.version,
        installed: list.runtime.installed,
        downloading: list.runtime.downloading,
        phase: list.runtime.phase
      }
      // Clear the live runtime progress bar once the in-flight entry is gone
      // (finish() drops it and broadcasts downloads:changed); otherwise the
      // "extracting" 100% state stays pinned forever.
      if (!list.runtime.downloading) {
        this.runtimeDownloading = null
      }
      const known = new Set(list.models.map((e) => e.url))
      for (const key of Object.keys(this.modelDownloads)) {
        // Strip only the leading `type:` prefix. The URL itself contains
        // colons (`https://…`), so the old `split(':', 2)` truncated every
        // key to `'https'`, which never matched the list — every
        // downloads:changed broadcast then wiped ALL live progress keys and
        // still-downloading rows snapped back to an indeterminate "0 B" bar.
        const url = key.slice(key.indexOf(':') + 1)
        const entry = list.models.find((e) => e.url === url)
        if (!known.has(url) || entry?.status === 'failed') {
          delete this.modelDownloads[key]
        }
      }
    },
    async cancelDownload(arg: string): Promise<void> {
      await window.api.downloadsCancel(arg)
    },
    async setPaused(paused: boolean): Promise<void> {
      await window.api.downloadsSetPaused(paused)
    },
    async save(patch: Partial<Settings>) {
      this.settings = await window.api.settingsSave(patch)
    },
    /**
     * Persist + apply a theme. Validates against the registry (throws on an
     * unknown key), then persists the choice so it survives relaunch. Applies
     * immediately so the switch is synchronous from the caller's perspective.
     */
    async setTheme(key: ThemeKey): Promise<void> {
      assertThemeKey(key)
      this.theme = key
      applyTheme(key)
      await this.save({ theme: key })
    },
    /** Restore the persisted theme on launch. Call after `load()`. */
    applyPersistedTheme(): void {
      const key = this.settings.theme ?? 'default'
      this.theme = key
      applyTheme(key)
    },
    async loadRuntimeVersions() {
      this.runtimeVersions = await window.api.runtimeVersions()
    },
    /**
     * Shared post-change refresh for Check and Reset: re-pull the versions
     * list and the app configs, clear a runtimeVersion that no longer exists
     * (the `??` fallbacks in the selectedVersion getter and the gen:start
     * handler then resolve to the newest version, matching fresh-install
     * behavior), and refresh the Downloads-section runtime row (driven by
     * `downloads:list`, which computes
     * `version = settings.runtimeVersion ?? listRuntimeVersion() ?? ''`).
     */
    async refreshRuntimeConfig(): Promise<void> {
      await this.loadRuntimeVersions()
      await useAppStore().loadConfigs()
      const versions = new Set(this.runtimeVersions.map((v) => v.version))
      if (
        this.settings.runtimeVersion !== undefined &&
        !versions.has(this.settings.runtimeVersion)
      ) {
        // `save({ runtimeVersion: undefined })` drops the key from the
        // persisted JSON (JSON.stringify omits undefined), so the ?? fallbacks
        // resolve to the newest version. Do NOT pin a specific version.
        await this.save({ runtimeVersion: undefined })
      }
      try {
        this.applyDownloadsList(await window.api.downloadsList())
      } catch {
        /* registry unavailable */
      }
    },
    /**
     * Fetch the remote runtime config and apply it. The refresh runs *after*
     * main has already committed the override; if it throws, we log and
     * continue so the UI still toasts the real check result — never
     * "Check failed" for a successful update. A stale list self-heals the
     * next time Settings is opened.
     */
    async checkRuntimeUpdates(): Promise<RuntimeCheckResult> {
      const result = await window.api.runtimeCheckUpdates()
      try {
        await this.refreshRuntimeConfig()
      } catch (e) {
        console.warn('[settings] runtime config refresh failed:', (e as Error).message)
      }
      return result
    },
    /** Delete the override so the bundled runtime config becomes active. */
    async resetRuntimeConfig(): Promise<void> {
      await window.api.runtimeResetConfig()
      try {
        await this.refreshRuntimeConfig()
      } catch (e) {
        // The reset itself succeeded; a stale list self-heals when Settings
        // is reopened.
        console.warn('[settings] runtime config refresh failed:', (e as Error).message)
      }
    },
    /**
     * Shared post-change refresh for hub Check and Reset: re-pull the app
     * configs so `configs.hub` (providers + repo maps) feeds ChatPanel,
     * ModelPickerDialog and the Settings search helpers.
     */
    async refreshHubConfig(): Promise<void> {
      await useAppStore().loadConfigs()
    },
    /**
     * Fetch the remote hub config and apply it. The refresh runs *after*
     * main has already committed the override; if it throws, we log and
     * continue so the UI still toasts the real check result — never
     * "Check failed" for a successful update. The catalog rescan is
     * deliberately NOT here — it is a UI-level concern (SettingsDialog
     * fires it after the toast).
     */
    async checkHubUpdates(): Promise<HubCheckResult> {
      const result = await window.api.hubCheckUpdates()
      try {
        await this.refreshHubConfig()
      } catch (e) {
        console.warn('[settings] hub config refresh failed:', (e as Error).message)
      }
      return result
    },
    /** Delete the override so the bundled hub config becomes active. */
    async resetHubConfig(): Promise<void> {
      await window.api.hubResetConfig()
      try {
        await this.refreshHubConfig()
      } catch (e) {
        // The reset itself succeeded; a stale list self-heals when Settings
        // is reopened.
        console.warn('[settings] hub config refresh failed:', (e as Error).message)
      }
    },
    async downloadRuntime(version: string, key: string) {
      this.runtimeDownloading = { version, downloadedBytes: 0, totalBytes: 0 }
      try {
        // `false` is the Pause/Cancel sentinel from the runtime:download
        // handler (the invoke resolves it instead of rejecting, because
        // Electron logs every handler rejection as "Error occurred in
        // handler"). Rethrow the abort error so the dialog's
        // isAbortedDownload filter keeps working.
        const ok = await window.api.runtimeDownload(version, key as never)
        if (!ok) throw new Error(DOWNLOAD_ABORTED_MESSAGE)
      } finally {
        this.runtimeDownloading = null
        await this.loadRuntimeVersions()
      }
    },
    async listModels(type: ModelType) {
      this.modelLists[type] = await window.api.modelsList(type)
    },
    async downloadModel(type: ModelType, url: string, provider?: string, force = false) {
      const key = `${type}:${url}`
      this.modelDownloads[key] = { type, url, downloadedBytes: 0, totalBytes: 0 }
      try {
        const dest = await window.api.modelsDownload(type, url, provider, force)
        // '' is the Pause/Cancel sentinel from the models:download handler
        // (the invoke resolves it instead of rejecting, because Electron logs
        // every handler rejection as "Error occurred in handler"). Rethrow the
        // abort error so awaiters keep filtering it via DOWNLOAD_ABORTED_MESSAGE.
        if (dest === '') throw new Error(DOWNLOAD_ABORTED_MESSAGE)
        return dest
      } finally {
        delete this.modelDownloads[key]
        await this.listModels(type)
      }
    },
    async removeModel(type: ModelType, name: string) {
      await window.api.modelsRemove(type, name)
      await this.listModels(type)
    },
    samplingFor(diffusionType: string, defaults: SamplingDefaults): SamplingDefaults {
      return { ...defaults, ...(this.settings.sampling?.[diffusionType] ?? {}) }
    }
  }
})
