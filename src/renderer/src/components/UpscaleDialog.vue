<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CatalogEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { useUpscalerStore } from '../stores/upscaler'
import { toast } from '../toast'
import DownloadProgress from './DownloadProgress.vue'

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const upscalerStore = useUpscalerStore()

// The source image thumbnail (a data URL from the main process).
const thumbSrc = ref('')
const thumbFailed = ref(false)

// Selected model: the hub default (isDefault) preselected; only INSTALLED
// models are selectable — a not-installed row renders disabled.
const selected = ref<CatalogEntry | null>(null)

// Tile Size: number-only textbox defaulting to 128 (the sd-cli default).
const tileSizeText = ref('128')

const rows = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'pixel_upscaler')
)

function baseName(name: string): string {
  return name.split('/').pop() ?? name
}

/** Installed state via basename compare against models.list('pixel_upscaler')
 *  (the permissive basename rule from the collision-hardening plan). */
function isInstalled(e: CatalogEntry): boolean {
  return (settingsStore.modelLists.pixel_upscaler ?? []).some((f) => f.name === baseName(e.name))
}

function dlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`pixel_upscaler:${e.url}`]
}

async function downloadEntry(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('pixel_upscaler', e.url, e.provider, false, e.diffusionType)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    const msg = (err as Error).message
    if (msg !== 'Download aborted') {
      toast(`Download failed: ${msg}`, 'error')
    }
  }
}

const installedRows = computed(() => rows.value.filter((e) => isInstalled(e)))

function fmtBytes(n: number): string {
  if (!n || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/** Number-only sanitize: strip everything that is not a digit. */
function onTileSizeInput(): void {
  const cleaned = tileSizeText.value.replace(/[^0-9]/g, '')
  if (cleaned !== tileSizeText.value) tileSizeText.value = cleaned
}

const tileSizeValid = computed(() => {
  const n = Number(tileSizeText.value)
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1
})

function proceed(): void {
  if (!selected.value || !tileSizeValid.value) return
  upscalerStore.proceed(
    selected.value.name,
    selected.value.provider,
    selected.value.diffusionType,
    Number(tileSizeText.value)
  )
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    upscalerStore.cancel()
  }
}

onMounted(async () => {
  // Esc-to-close via a capture listener (the ModelPickerDialog pattern).
  window.addEventListener('keydown', onKeydown, true)
  // Fresh installed names so the selectable rows are accurate.
  await settingsStore.listModels('pixel_upscaler')
  // Preselect the hub default when it is installed; else the first installed
  // row; else nothing (Proceed stays disabled).
  const def = rows.value.find((e) => e.isDefault && isInstalled(e)) ?? installedRows.value[0]
  selected.value = def ?? null
  // Source thumbnail.
  if (upscalerStore.sourcePath) {
    try {
      thumbSrc.value = await window.api.imageFromPath(upscalerStore.sourcePath)
    } catch {
      thumbFailed.value = true
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div class="dialog-backdrop" @click.self="upscalerStore.cancel()">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Upscale image">
      <header class="dialog-header">
        <h2>Upscale image</h2>
        <button class="icon close" title="Close" aria-label="Close" @click="upscalerStore.cancel()">×</button>
      </header>

      <div class="dialog-body">
        <div class="source-row">
          <img v-if="thumbSrc && !thumbFailed" :src="thumbSrc" class="source-thumb" alt="Source image" />
          <div v-else class="source-thumb source-missing mono">image unavailable</div>
          <div class="source-meta">
            <div class="muted">Upscale this image with an ESRGAN model.</div>
            <div class="faint mono source-name">{{ upscalerStore.sourcePath?.split(/[\\/]/).pop() }}</div>
          </div>
        </div>

        <div v-if="!rows.length" class="empty-state">
          <p class="muted">No upscaler models in the catalog. Use "Refresh hub" in Settings → Models to scan the repositories.</p>
        </div>

        <div v-else class="list-wrap">
          <ul class="model-list">
            <li
              v-for="e in rows"
              :key="e.id"
              class="model-item"
              :class="{ selected: selected?.id === e.id, disabled: !isInstalled(e) }"
              :title="e.name"
              @click="isInstalled(e) && (selected = e)"
            >
              <div class="item-main">
                <div class="title-row">
                  <span class="mono model-name">{{ baseName(e.name) }}</span>
                  <span class="tag">{{ e.diffusionType }}</span>
                  <span v-if="e.isDefault" class="tag default-tag">Default</span>
                  <template v-if="isInstalled(e)">
                    <span class="status-tag status-ok">Installed</span>
                  </template>
                  <template v-else>
                    <span class="status-tag status-none">Not installed</span>
                    <button
                      v-if="!dlState(e)"
                      class="dl-btn small"
                      @click.stop="downloadEntry(e)"
                    >Download</button>
                    <button
                      v-else
                      class="dl-btn small"
                      disabled
                    >Downloading…</button>
                  </template>
                </div>
                <div class="item-sub">
                  <span>{{ e.label && e.label !== e.name ? e.label : e.provider ?? '' }}</span>
                  <span v-if="e.size" class="faint"> · {{ fmtBytes(e.size) }}</span>
                </div>
              </div>
              <DownloadProgress
                v-if="dlState(e)"
                class="grow"
                :downloaded-bytes="dlState(e)!.downloadedBytes"
                :total-bytes="dlState(e)!.totalBytes"
              />
            </li>
          </ul>
        </div>

        <div class="tile-row">
          <label for="upscale-tile-size">Tile Size</label>
          <input
            id="upscale-tile-size"
            v-model="tileSizeText"
            class="tile-input"
            type="text"
            inputmode="numeric"
            @input="onTileSizeInput"
          />
          <span class="faint tile-hint" title="Lower values reduce VRAM use at a speed cost.">
            Lower values reduce VRAM use at a speed cost.
          </span>
        </div>
      </div>

      <footer class="dialog-footer">
        <button class="btn" @click="upscalerStore.cancel()">Cancel</button>
        <button class="btn primary" :disabled="!selected || !tileSizeValid" @click="proceed()">Proceed</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2600;
}
.dialog {
  width: min(560px, 92vw);
  max-height: min(640px, 88vh);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 {
  margin: 0;
  font-size: 16px;
}
.dialog-header .close {
  margin-left: auto;
}
.dialog-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 16px 16px;
  gap: 12px;
  overflow-y: auto;
}
.source-row {
  display: flex;
  gap: 12px;
  align-items: center;
}
.source-thumb {
  width: 96px;
  height: 96px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  flex-shrink: 0;
}
.source-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 11px;
}
.source-meta {
  min-width: 0;
}
.source-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-wrap {
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.model-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.model-item {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  display: flex;
  align-items: center;
}
.model-item:last-child {
  border-bottom: none;
}
.model-item:hover {
  background: var(--bg-hover);
}
.model-item.selected {
  background: var(--bg-hover);
  box-shadow: inset 2px 0 0 var(--accent);
}
.model-item.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.item-main {
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.model-name {
  font-size: 13px;
}
.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-faint);
}
.default-tag {
  color: var(--accent);
  border-color: var(--accent);
}
.status-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
}
.status-ok {
  color: var(--ok, #3fb950);
  border: 1px solid var(--ok, #3fb950);
}
.status-dl {
  color: var(--accent);
  border: 1px solid var(--accent);
}
.status-none {
  color: var(--text-faint);
  border: 1px solid var(--border);
}
.item-sub {
  font-size: 11px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tile-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tile-row label {
  font-size: 13px;
}
.tile-input {
  width: 90px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text);
}
.tile-hint {
  font-size: 11px;
}
.empty-state {
  padding: 16px;
  text-align: center;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.btn {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  cursor: pointer;
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* DL button */
.dl-btn {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.dl-btn:hover {
  opacity: 0.9;
}

.dl-btn.small {
  padding: 2px 8px;
  font-size: 11px;
}

.dl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Grow (DownloadProgress) */
.grow {
  margin-top: 6px;
}
</style>
