<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CatalogEntry, SessionControlNet } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'
import { baseName, matchesSearch, normalizeForSearch, providerLabel } from '../search'
import { toast } from '../toast'
import DownloadProgress from './DownloadProgress.vue'
import ImageFromPath from './ImageFromPath.vue'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
  save: [settings: SessionControlNet]
}>()

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()

// ---------- state ----------
const activeTab = ref<'model' | 'config'>('model')

// Form state (local copy — only saved on explicit Save)
const form = ref<SessionControlNet>({
  apply: false,
  model: ''
})

// ---------- installed models ----------
const installedFiles = computed(() => settingsStore.modelLists['control_net'] ?? [])
const installedNames = computed(() => new Set(installedFiles.value.map((f) => f.name)))

const hubProviders = computed(() => appStore.configs?.hub.providers ?? [])

// ---------- hub entries (LoRA-style global — no family filter) ----------
const controlNetEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'control_net')
)

/**
 * Catalog description for an installed model file, resolved by file name —
 * the same lookup pattern `SettingsDialog.vue` uses. Undefined for files
 * that are not in the catalog (e.g. manually placed).
 */
function installedDesc(name: string): string | undefined {
  return controlNetEntries.value.find((e) => baseName(e.name) === baseName(name))?.description
}

// ---------- search (filters BOTH installed + catalog) ----------
const modelQuery = ref('')

const filteredInstalled = computed(() => {
  const needle = normalizeForSearch(modelQuery.value).trim()
  if (!needle) return installedFiles.value
  return installedFiles.value.filter((f) => normalizeForSearch(f.name).includes(needle))
})

const filteredEntries = computed(() => {
  const q = modelQuery.value.trim()
  return q ? controlNetEntries.value.filter((e) => matchesSearch(e, q, hubProviders.value)) : controlNetEntries.value
})

const entryGroups = computed<[string, CatalogEntry[]][]>(() => {
  const map = new Map<string, CatalogEntry[]>()
  for (const e of filteredEntries.value) {
    const key = providerLabel(e.provider, hubProviders.value)
    const list = map.get(key) ?? []
    list.push(e)
    map.set(key, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entries]) => [provider, [...entries].sort((a, b) => a.label.localeCompare(b.label))])
})

// ---------- selected model ----------
const selectedModel = computed(() => form.value.model ?? '')

function isInstalled(e: CatalogEntry): boolean {
  return installedNames.value.has(baseName(e.name))
}

function dlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`${e.type}:${e.url}`]
}

// ---------- actions ----------
async function downloadEntry(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('control_net', e.url, e.provider, false, undefined)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    const msg = (err as Error).message
    if (msg !== 'Download aborted') {
      toast(`Download failed: ${msg}`, 'error')
    }
  }
}

function selectModel(name: string, provider?: string): void {
  form.value.model = name
  form.value.provider = provider
}

async function attachImage(): Promise<void> {
  try {
    const picked = await window.api.pickImages()
    if (picked && picked.length > 0) {
      form.value.image = picked[0]
    }
  } catch (err) {
    toast(`Failed to pick image: ${(err as Error).message}`, 'error')
  }
}

function clearImage(): void {
  form.value.image = undefined
}

function save(): void {
  // null clears when Apply is off and no model is selected
  if (!form.value.apply && !form.value.model) {
    emit('save', null as unknown as SessionControlNet)
    return
  }
  emit('save', { ...form.value })
}

function cancel(): void {
  emit('close')
}

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

function strengthInput(value: number | null): string {
  return value === null ? '' : String(value)
}

function onStrengthInput(text: string): void {
  const cleaned = text.replace(/[^0-9.]/g, '')
  const num = parseFloat(cleaned)
  const val: number | null = isNaN(num) ? null : num
  form.value.strength = val
}

onMounted(async () => {
  await settingsStore.listModels('control_net')
  // Restore the session's saved Control Net config if present
  const session = await window.api.sessionsGet(props.sessionId)
  if (session?.inputs?.controlNet) {
    const saved = session.inputs.controlNet
    form.value = {
      apply: saved.apply,
      model: saved.model,
      provider: saved.provider,
      image: saved.image,
      strength: saved.strength ?? null
    }
  }
})
</script>

<template>
  <div class="dialog-backdrop" @click.self="cancel()">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Control Net settings">
      <header class="dialog-header">
        <h2>Control Net</h2>
        <button class="icon close" title="Close" aria-label="Close" @click="cancel()">×</button>
      </header>

      <div class="dialog-body">
        <!-- Tabs -->
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: activeTab === 'model' }"
            @click="activeTab = 'model'"
          >Models</button>
          <button
            class="tab"
            :class="{ active: activeTab === 'config' }"
            @click="activeTab = 'config'"
          >Config</button>
        </div>

        <!-- Hub refresh progress (indeterminate while the catalog is being rescanned) -->
        <div v-if="appStore.catalogScanning" class="refresh-status">
          <p class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>
          <div class="progress indeterminate">
            <div class="progress-fill"></div>
          </div>
        </div>

        <!-- Tab 1: Models -->
        <div v-if="activeTab === 'model'" class="tab-content">
          <!-- Search box (filters both installed + catalog) -->
          <input
            v-model="modelQuery"
            class="search-input"
            type="text"
            placeholder="Search Control Net models…"
          />

          <div v-if="!controlNetEntries.length && !installedFiles.length" class="empty-state">
            <p class="muted">No Control Net entries in the catalog. Use "Refresh hub" in Settings to scan the repositories.</p>
            <button class="btn primary" style="margin-top: 12px;" @click="appStore.refreshCatalog()">Refresh hub</button>
          </div>

          <template v-else>
            <!-- Installed models -->
            <h4>Installed</h4>
            <ul class="model-list">
              <li
                v-for="f in filteredInstalled"
                :key="f.name"
                class="model-item"
                :class="{ selected: selectedModel === f.name }"
                :title="f.name"
                @click="selectModel(f.name, f.provider)"
              >
                <div class="item-main">
                  <div class="title-row">
                    <span class="mono model-name">{{ f.name }}</span>
                    <span class="status-tag status-ok">Installed</span>
                  </div>
                  <div class="item-sub">
                    <span v-if="installedDesc(f.name)" class="desc">{{ installedDesc(f.name) }}</span>
                    <span v-else></span>
                    <span v-if="f.size" class="faint"> · {{ fmtBytes(f.size) }}</span>
                  </div>
                </div>
              </li>
              <li v-if="!installedFiles.length" class="muted">No Control Net models installed.</li>
              <li v-else-if="!filteredInstalled.length" class="muted">No installed Control Net models match "{{ modelQuery }}".</li>
            </ul>

            <!-- Available from hub -->
            <h4>Available from hub</h4>
            <p v-if="!entryGroups.length && modelQuery.trim()" class="muted">No Control Net models match "{{ modelQuery }}".</p>
            <div v-for="[provider, entries] in entryGroups" :key="provider" class="provider-group">
              <h5>{{ provider }}</h5>
              <ul class="model-list">
                <li
                  v-for="e in entries"
                  :key="e.id"
                  class="model-item"
                  :class="{ disabled: !isInstalled(e) }"
                  :title="e.name"
                  @click="isInstalled(e) && selectModel(baseName(e.name), e.provider)"
                >
                  <div class="item-main">
                    <div class="title-row">
                      <span class="mono model-name">{{ baseName(e.name) }}</span>
                      <template v-if="isInstalled(e)">
                        <span class="status-tag status-ok">Installed</span>
                      </template>
                      <template v-else>
                        <span class="status-tag status-none">Not installed</span>
                        <button
                          v-if="dlState(e)"
                          class="dl-btn small"
                          disabled
                        >Downloading…</button>
                        <button
                          v-else
                          class="dl-btn small"
                          @click.stop="downloadEntry(e)"
                        >Download</button>
                      </template>
                    </div>
                    <div class="item-sub">
                      <span v-if="e.description" class="desc">{{ e.description }}</span>
                      <span v-else>{{ e.label && e.label !== e.name ? e.label : provider }}</span>
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
          </template>
        </div>

        <!-- Tab 2: Config -->
        <div v-if="activeTab === 'config'" class="tab-content">
          <details class="option-section" open>
            <summary>Settings</summary>
            <div class="option-grid">
              <label class="checkbox-label">
                <input type="checkbox" v-model="form.apply" />
                <span>Apply Control Net</span>
              </label>
            </div>
          </details>

          <details class="option-section" open>
            <summary>Control Image</summary>
            <div class="option-grid">
              <label class="full-width">
                <span>Control image</span>
                <div class="image-row">
                  <button class="btn" @click="attachImage()">Attach</button>
                  <span v-if="form.image" class="image-path">{{ baseName(form.image) }}</span>
                  <button v-if="form.image" class="btn" @click="clearImage()">Clear</button>
                  <span v-else class="muted">No image attached</span>
                </div>
                <ImageFromPath
                  v-if="form.image"
                  :path="form.image"
                  alt="Control image preview"
                  :max="200"
                />
                <span class="hint">The control image to condition the generation with (--control-image)</span>
              </label>
            </div>
          </details>

          <details class="option-section" open>
            <summary>Strength</summary>
            <div class="option-grid">
              <label>
                <span>Control strength</span>
                <input
                  :value="strengthInput(form.strength ?? null)"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.9"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onStrengthInput(t) }"
                />
                <span class="hint">Emit --control-strength; empty omits the flag (sd-cli default: 0.9)</span>
              </label>
            </div>
          </details>
        </div>
      </div>

      <footer class="dialog-footer">
        <button class="btn" @click="cancel()">Cancel</button>
        <button class="btn primary" @click="save()">Save</button>
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
  z-index: 1000;
  padding: 20px;
}

.dialog {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 640px;
  max-width: 100%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

/* Tabs */
.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.tab {
  padding: 8px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* Tab content */
.tab-content {
  min-height: 300px;
}

.empty-state {
  text-align: center;
  padding: 20px;
}

/* Model list */
.model-list {
  list-style: none;
  padding: 0;
  margin: 0 0 16px 0;
}

.model-item {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.1s;
}

.model-item:hover {
  background: var(--bg-hover);
}

.model-item.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.model-item.disabled {
  opacity: 0.5;
  cursor: default;
}

.item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.model-name {
  font-size: 13px;
}

.item-sub {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.desc {
  color: var(--text-dim);
}

.faint {
  color: var(--text-faint);
}

.status-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}

.status-ok {
  background: #166534;
  color: #bbf7d0;
}

.status-none {
  background: var(--bg-hover);
  color: var(--text-dim);
}

/* Provider group */
.provider-group {
  margin-bottom: 12px;
}

.provider-group h5 {
  margin: 8px 0 4px;
  font-size: 13px;
  color: var(--text-dim);
}

/* Search input */
.search-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  margin-bottom: 12px;
  box-sizing: border-box;
}

.search-input::placeholder {
  color: var(--text-dim);
}

/* DL button */
.dl-btn {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.dl-btn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.dl-btn.small {
  padding: 3px 8px;
  font-size: 11px;
}

.dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Collapsible sections */
.option-section {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 12px;
  overflow: hidden;
}

.option-section summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-hover);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  list-style: none;
}

.option-section summary::-webkit-details-marker {
  display: none;
}

.option-section summary::after {
  content: '▾';
  font-size: 12px;
  transition: transform 0.15s;
}

.option-section[open] summary::after {
  content: '▴';
}

.option-section .option-grid {
  padding: 12px 14px;
}

/* Option grid */
.option-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.option-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.option-grid label span {
  color: var(--text-dim);
}

.option-grid input[type="text"] {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
}

.option-grid .hint {
  font-size: 11px;
  color: var(--text-dim);
  font-style: italic;
}

.option-grid label.checkbox-label {
  display: flex;
  gap: 4px;
  flex-direction: row;
  align-items: center;
}

.option-grid label.checkbox-label span {
  font-size: 13px;
}

.option-grid label.checkbox-label input[type="checkbox"] {
  width: auto;
}

.full-width {
  grid-column: 1 / -1;
}

/* Image row */
.image-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.image-path {
  font-size: 12px;
  color: var(--text);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Image preview */
.image-preview {
  margin-top: 8px;
  max-width: 200px;
  max-height: 150px;
  border-radius: 6px;
  border: 1px solid var(--border);
  object-fit: contain;
}

/* Footer */
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.btn {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn.primary:hover {
  opacity: 0.9;
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Close button */
.dialog .icon.close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.dialog .icon.close:hover {
  color: var(--text);
}

/* Grow (DownloadProgress) */
.grow {
  margin-top: 6px;
}
</style>
