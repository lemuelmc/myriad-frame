/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { defineStore } from 'pinia'
import type {
  AllConfigs,
  PlatformInfo,
  HubCatalog,
  ResolutionEntry,
  InitStage,
  ConfigUpdateStatus
} from '@shared/types'
import { toast } from '../toast'

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
    /**
     * Update-toast dedupe flags (in-memory only, reset every launch): a flag
     * is set when its launch-update toast has been shown this session, so the
     * updates:available push and the updates:get pull can both deliver
     * without double-toasting. No persistence — an unapplied update re-toasts
     * on every launch by design.
     */
    notified: { hub: false, runtime: false } as Record<'hub' | 'runtime', boolean>,
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
    /**
     * Toast the launch-time update-check result (detect-only — applying is a
     * manual Settings → Check action). Called from both delivery paths: the
     * `updates:available` push and the `updates:get` pull-on-mount; the
     * `notified` flags make the pair idempotent. null (check not completed
     * yet) is a no-op.
     */
    notifyUpdates(status: ConfigUpdateStatus | null): void {
      if (!status) return
      const messages: Record<'hub' | 'runtime', string> = {
        hub: 'New models available. Go to Settings → Models and click "Check" and "Refresh hub" to update the model catalog.',
        runtime: 'New runtime available for downloads. Go to Settings → Runtime and click "Check" to update the catalog.'
      }
      for (const key of ['hub', 'runtime'] as const) {
        if (status[key] && !this.notified[key]) {
          this.notified[key] = true
          // 10 s TTL — these are action prompts, not confirmations.
          toast(messages[key], 'info', 10000)
        }
      }
    },
    resolutionsFor(diffusionType: string): ResolutionEntry[] {
      return this.configs?.resolution[diffusionType] ?? []
    }
  }
})
