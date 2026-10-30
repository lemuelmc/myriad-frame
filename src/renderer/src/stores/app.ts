/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'
import type { AllConfigs, PlatformInfo, HubCatalog, ResolutionEntry, InitStage } from '@shared/types'

export const useAppStore = defineStore('app', {
  state: () => ({
    ready: false,
    initStage: 'platform' as InitStage,
    initMessage: 'Starting…',
    initProgress: { downloadedBytes: 0, totalBytes: 0 },
    platform: null as PlatformInfo | null,
    configs: null as AllConfigs | null,
    catalog: null as HubCatalog | null,
    catalogScanning: false,
    catalogMessage: '',
    about: null as {
      name: string
      version: string
      electron: string
      chrome: string
      node: string
      platform: string
    } | null
  }),
  actions: {
    async loadConfigs() {
      this.configs = await window.api.configs()
    },
    async loadCatalog() {
      this.catalog = await window.api.hubCatalog()
    },
    async refreshCatalog() {
      this.catalogScanning = true
      this.catalogMessage = 'Scanning model hub…'
      try {
        this.catalog = await window.api.hubRefresh()
      } finally {
        this.catalogScanning = false
        this.catalogMessage = ''
      }
    },
    async loadAbout() {
      this.about = await window.api.about()
    },
    resolutionsFor(diffusionType: string): ResolutionEntry[] {
      return this.configs?.resolution[diffusionType] ?? []
    }
  }
})
