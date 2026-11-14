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

/** GitHub releases page — the "Download" target for the launch app-version toast. */
export const RELEASES_URL = 'https://github.com/lemuelmc/myriad-frame/releases'

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
     * True while a hub catalog scan is in flight — drives the indeterminate
     * progress bar shown below the "Refresh hub" buttons in the Settings
     * dialog and LoRA browser. Reset in the `finally` block of refreshCatalog().
     */
    catalogProgressBar: false,
    /**
      * Update-toast dedupe flags (in-memory only, reset every launch): a flag
     * is set when its launch-update toast has been shown this session, so the
     * updates:available push and the updates:get pull can both deliver
     * without double-toasting. No persistence — an unapplied update re-toasts
     * on every launch by design.
     */
    notified: { hub: false, runtime: false } as Record<'hub' | 'runtime', boolean>,
    /** In-memory dedupe for the app-version toast (reset every launch). */
    appNotified: false,
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
      this.catalogProgressBar = true
      try {
        this.catalog = await window.api.hubRefresh()
      } finally {
        this.catalogScanning = false
        this.catalogMessage = ''
        this.catalogProgressBar = false
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
    },
    /**
     * Toast when the launch-time app-version check finds a version strictly
     * greater than the bundled one. The download action opens the GitHub
     * releases page in the system browser. In-memory dedupe so the push and
     * pull-on-mount paths don't double-toast.
     */
    notifyAppUpdate(available: boolean): void {
      if (!available || this.appNotified) return
      this.appNotified = true
      const current = this.about?.version
      const action = available ? { label: 'Download', run: () => window.open(RELEASES_URL, '_blank') } : undefined
      toast(
        available
          ? `Myriad Frame ${current ?? ''} is out of date. A new version is available for download.`
          : '',
        'info',
        10000,
        action
      )
    }
  }
})
