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

import { defineStore } from 'pinia'
import type {
  DownloadProgress,
  ModelFile,
  ModelType,
  PerformanceSettings,
  RuntimeVersionInfo,
  SamplingDefaults,
  Settings
} from '@shared/types'

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
    runtimeVersions: [] as RuntimeVersionInfo[],
    runtimeDownloading: null as RuntimeDownloadState | null,
    modelDownloads: {} as Record<string, ModelDownloadState>,
    modelLists: {} as Record<ModelType, ModelFile[]>
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
    },
    async save(patch: Partial<Settings>) {
      this.settings = await window.api.settingsSave(patch)
    },
    async loadRuntimeVersions() {
      this.runtimeVersions = await window.api.runtimeVersions()
    },
    async downloadRuntime(version: string, key: string) {
      this.runtimeDownloading = { version, downloadedBytes: 0, totalBytes: 0 }
      try {
        await window.api.runtimeDownload(version, key as never)
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
        await window.api.modelsDownload(type, url, provider, force)
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
