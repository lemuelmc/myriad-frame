<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CatalogEntry, AdetailerSettings } from '@shared/types'
import { DEFAULT_ADETAILER_SETTINGS } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { baseName, matchesSearch, providerLabel } from '../search'
import { toast } from '../toast'
import DownloadProgress from './DownloadProgress.vue'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
  save: [settings: AdetailerSettings]
}>()

const appStore = useAppStore()
const settingsStore = useSettingsStore()

// ---------- state ----------
const activeTab = ref<'model' | 'options'>('model')
const applied = ref(false)

// Form state (local copy — only saved on explicit Save)
const form = ref<AdetailerSettings>({ ...DEFAULT_ADETAILER_SETTINGS })

// ---------- installed models ----------
const installedFiles = computed(() => settingsStore.modelLists['adetailer'] ?? [])
const installedNames = computed(() => new Set(installedFiles.value.map((f) => f.name)))

const hubProviders = computed(() => appStore.configs?.hub.providers ?? [])

// ---------- hub entries ----------
const adetailerEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'adetailer')
)

// ---------- search ----------
const query = ref('')

const filteredEntries = computed(() => {
  const q = query.value.trim()
  return q ? adetailerEntries.value.filter((e) => matchesSearch(e, q, hubProviders.value)) : adetailerEntries.value
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
  return settingsStore.modelDownloads[`adetailer:${e.url}`]
}

// ---------- actions ----------
async function downloadEntry(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('adetailer', e.url, e.provider, false, e.diffusionType)
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

function resetSection(section: string): void {
  const defaults = DEFAULT_ADETAILER_SETTINGS
  switch (section) {
    case 'general':
      form.value.adPrompt = defaults.adPrompt
      form.value.adNegativePrompt = defaults.adNegativePrompt
      break
    case 'detection':
      form.value.inputSize = defaults.inputSize
      form.value.confidence = defaults.confidence
      form.value.nms = defaults.nms
      form.value.maxDetections = defaults.maxDetections
      break
    case 'mask_processing':
      form.value.maskKLargest = defaults.maskKLargest
      form.value.maskFilterMethod = defaults.maskFilterMethod
      form.value.maskMinRatio = defaults.maskMinRatio
      form.value.maskMaxRatio = defaults.maskMaxRatio
      form.value.sortBy = defaults.sortBy
      break
    case 'mask_editing':
      form.value.dilateErode = defaults.dilateErode
      form.value.offsetX = defaults.offsetX
      form.value.offsetY = defaults.offsetY
      form.value.maskBlur = defaults.maskBlur
      break
    case 'mask_mode':
      form.value.maskMode = defaults.maskMode
      form.value.mergeMasks = defaults.mergeMasks
      form.value.invertMask = defaults.invertMask
      break
    case 'inpainting':
      form.value.inpaintPadding = defaults.inpaintPadding
      form.value.inpaintOnlyMasked = defaults.inpaintOnlyMasked
      form.value.inpaintWidth = defaults.inpaintWidth
      form.value.inpaintHeight = defaults.inpaintHeight
      form.value.denoisingStrength = defaults.denoisingStrength
      break
    case 'inference':
      form.value.detailSteps = defaults.detailSteps
      form.value.detailCfg = defaults.detailCfg
      form.value.detailSampler = defaults.detailSampler
      form.value.detailScheduler = defaults.detailScheduler
      form.value.clipSkip = defaults.clipSkip
      break
  }
  toast(`Reset ${section} to defaults`, 'ok')
}

function save(): void {
  applied.value = true
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

function numberInput(value: number | null): string {
  return value === null ? '' : String(value)
}

function onNumberInput(field: keyof AdetailerSettings, text: string): void {
  const cleaned = text.replace(/[^0-9.\-]/g, '')
  const num = parseFloat(cleaned)
  const val: number | null = isNaN(num) ? null : num
  ;(form.value[field] as number | null) = val
}

// ---------- reset all ----------
function resetAll(): void {
  form.value = { ...DEFAULT_ADETAILER_SETTINGS }
  toast('Reset all options to defaults', 'ok')
}

onMounted(async () => {
  await settingsStore.listModels('adetailer')
  // Restore the session's saved model if present
  const session = await window.api.sessionsGet(props.sessionId)
  if (session?.inputs?.adetailer) {
    const saved = session.inputs.adetailer
    form.value = {
      enabled: saved.enabled,
      model: saved.model,
      provider: saved.provider,
      adPrompt: saved.adPrompt,
      adNegativePrompt: saved.adNegativePrompt,
      inputSize: saved.inputSize,
      confidence: saved.confidence,
      nms: saved.nms,
      maxDetections: saved.maxDetections,
      maskKLargest: saved.maskKLargest,
      maskFilterMethod: saved.maskFilterMethod,
      maskMinRatio: saved.maskMinRatio,
      maskMaxRatio: saved.maskMaxRatio,
      dilateErode: saved.dilateErode,
      offsetX: saved.offsetX,
      offsetY: saved.offsetY,
      maskMode: saved.maskMode,
      mergeMasks: saved.mergeMasks,
      invertMask: saved.invertMask,
      maskBlur: saved.maskBlur,
      inpaintPadding: saved.inpaintPadding,
      inpaintOnlyMasked: saved.inpaintOnlyMasked,
      inpaintWidth: saved.inpaintWidth,
      inpaintHeight: saved.inpaintHeight,
      denoisingStrength: saved.denoisingStrength,
      sortBy: saved.sortBy,
      detailSteps: saved.detailSteps,
      detailCfg: saved.detailCfg,
      detailSampler: saved.detailSampler,
      detailScheduler: saved.detailScheduler,
      clipSkip: saved.clipSkip
    }
  }
})

onBeforeUnmount(() => {
  // No cleanup needed
})
</script>

<template>
  <div class="dialog-backdrop" @click.self="cancel()">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="ADetailer settings">
      <header class="dialog-header">
        <h2>ADetailer</h2>
        <button class="icon close" title="Close" aria-label="Close" @click="cancel()">×</button>
      </header>

      <div class="dialog-body">
        <!-- Tabs -->
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: activeTab === 'model' }"
            @click="activeTab = 'model'"
          >Model Selection</button>
          <button
            class="tab"
            :class="{ active: activeTab === 'options' }"
            @click="activeTab = 'options'"
          >Options</button>
        </div>

        <!-- Tab 1: Model Selection -->
        <div v-if="activeTab === 'model'" class="tab-content">
          <div v-if="!adetailerEntries.length" class="empty-state">
            <p class="muted">No ADetailer entries in the catalog. Use "Refresh hub" in Settings → Adetailer to scan the repositories.</p>
          </div>

          <div v-else>
            <!-- Installed models -->
            <h4>Installed</h4>
            <ul class="model-list">
              <li
                v-for="f in installedFiles"
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
                    <span>{{ fmtBytes(f.size) }}</span>
                  </div>
                </div>
              </li>
              <li v-if="!installedFiles.length" class="muted">No ADetailer models installed yet.</li>
            </ul>

            <!-- Available from hub -->
            <h4>Available from hub</h4>
            <input
              v-model="query"
              class="search-input"
              type="text"
              placeholder="Filter ADetailer models…"
            />
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
                      <span v-if="e.isDefault" class="tag default-tag">Default</span>
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
                      <span>{{ e.label && e.label !== e.name ? e.label : provider }}</span>
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
          </div>
        </div>

        <!-- Tab 2: Options -->
        <div v-if="activeTab === 'options'" class="tab-content">
          <div class="options-header">
            <span>ADetailer Options</span>
            <button class="dl-btn small" @click="resetAll()">Reset All</button>
          </div>

          <!-- General -->
          <details class="option-section" open>
            <summary>General</summary>
            <div class="option-grid">
              <label class="checkbox-label">
                <input type="checkbox" v-model="form.enabled" />
                <span>Apply ADetailer</span>
              </label>
              <label class="textarea-label full-width">
                <span>AD Prompt</span>
                <textarea
                  v-model="form.adPrompt"
                  rows="2"
                  placeholder="Optional — empty inherits the main prompt"
                ></textarea>
                <span class="hint">Supports substitutions: [PROMPT], [SEP], [SKIP]</span>
              </label>
              <label class="textarea-label full-width">
                <span>AD Negative Prompt</span>
                <textarea
                  v-model="form.adNegativePrompt"
                  rows="2"
                  placeholder="Optional — empty inherits the main negative prompt"
                ></textarea>
              </label>
            </div>
          </details>

          <!-- Detection -->
          <details class="option-section" open>
            <summary>
              Detection
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('detection')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Input Size</span>
                <input
                  :value="numberInput(form.inputSize)"
                  type="text"
                  inputmode="numeric"
                  placeholder="640"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('inputSize', t) }"
                />
              </label>
              <label>
                <span>Confidence</span>
                <input
                  :value="numberInput(form.confidence)"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.3"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('confidence', t) }"
                />
              </label>
              <label>
                <span>NMS</span>
                <input
                  :value="numberInput(form.nms)"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.45"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('nms', t) }"
                />
              </label>
              <label>
                <span>Max Detection</span>
                <input
                  :value="numberInput(form.maxDetections)"
                  type="text"
                  inputmode="numeric"
                  placeholder="100"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('maxDetections', t) }"
                />
              </label>
            </div>
          </details>

          <!-- Mask Processing -->
          <details class="option-section" open>
            <summary>
              Mask Processing
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('mask_processing')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Mask K Largest</span>
                <input
                  :value="numberInput(form.maskKLargest)"
                  type="text"
                  inputmode="numeric"
                  placeholder="0"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('maskKLargest', t) }"
                />
              </label>
              <label>
                <span>Mask Filter Method</span>
                <select v-model="form.maskFilterMethod">
                  <option :value="null">None</option>
                  <option value="area">Area</option>
                  <option value="confidence">Confidence</option>
                </select>
              </label>
              <label>
                <span>Mask Min Ratio</span>
                <input
                  :value="numberInput(form.maskMinRatio)"
                  type="text"
                  inputmode="decimal"
                  placeholder="0"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('maskMinRatio', t) }"
                />
              </label>
              <label>
                <span>Mask Max Ratio</span>
                <input
                  :value="numberInput(form.maskMaxRatio)"
                  type="text"
                  inputmode="decimal"
                  placeholder="1"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('maskMaxRatio', t) }"
                />
              </label>
              <label>
                <span>Sort By</span>
                <select v-model="form.sortBy">
                  <option :value="null">None</option>
                  <option value="left_to_right">Left-to-right</option>
                  <option value="center_to_edge">Center-to-edge</option>
                  <option value="area">Area</option>
                </select>
              </label>
            </div>
          </details>

          <!-- Mask Editing -->
          <details class="option-section" open>
            <summary>
              Mask Editing
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('mask_editing')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Dilate Erode</span>
                <input
                  :value="numberInput(form.dilateErode)"
                  type="text"
                  inputmode="numeric"
                  placeholder="4"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('dilateErode', t) }"
                />
              </label>
              <label>
                <span>Offset (X)</span>
                <input
                  :value="numberInput(form.offsetX)"
                  type="text"
                  inputmode="numeric"
                  placeholder="0"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('offsetX', t) }"
                />
              </label>
              <label>
                <span>Offset (Y)</span>
                <input
                  :value="numberInput(form.offsetY)"
                  type="text"
                  inputmode="numeric"
                  placeholder="0"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('offsetY', t) }"
                />
              </label>
              <label>
                <span>Mask Blur</span>
                <input
                  :value="numberInput(form.maskBlur)"
                  type="text"
                  inputmode="numeric"
                  placeholder="4"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('maskBlur', t) }"
                />
              </label>
            </div>
          </details>

          <!-- Mask Mode -->
          <details class="option-section" open>
            <summary>
              Mask Mode
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('mask_mode')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Mask (MODE)</span>
                <select v-model="form.maskMode">
                  <option :value="null">None</option>
                  <option value="merge">Merge</option>
                  <option value="merge_invert">Merge Invert</option>
                </select>
              </label>
              <label>
                <span>Merge Mask</span>
                <select v-model="form.mergeMasks">
                  <option :value="null">None</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              </label>
              <label>
                <span>Invert Mask</span>
                <select v-model="form.invertMask">
                  <option :value="null">None</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              </label>
            </div>
          </details>

          <!-- Inpainting -->
          <details class="option-section" open>
            <summary>
              Inpainting
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('inpainting')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Inpaint Padding</span>
                <input
                  :value="numberInput(form.inpaintPadding)"
                  type="text"
                  inputmode="numeric"
                  placeholder="32"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('inpaintPadding', t) }"
                />
              </label>
              <label>
                <span>Inpaint Only Mask</span>
                <select v-model="form.inpaintOnlyMasked">
                  <option :value="null">None</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              </label>
              <label>
                <span>Inpaint Width</span>
                <input
                  :value="numberInput(form.inpaintWidth)"
                  type="text"
                  inputmode="numeric"
                  placeholder="512"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('inpaintWidth', t) }"
                />
              </label>
              <label>
                <span>Inpaint Height</span>
                <input
                  :value="numberInput(form.inpaintHeight)"
                  type="text"
                  inputmode="numeric"
                  placeholder="512"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('inpaintHeight', t) }"
                />
              </label>
              <label>
                <span>Denoising Strength</span>
                <input
                  :value="numberInput(form.denoisingStrength)"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.4"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('denoisingStrength', t) }"
                />
              </label>
            </div>
          </details>

          <!-- Inference -->
          <details class="option-section" open>
            <summary>
              Inference
              <button class="reset-btn" title="Reset to defaults" @click="resetSection('inference')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </summary>
            <div class="option-grid">
              <label>
                <span>Detail Steps</span>
                <input
                  :value="numberInput(form.detailSteps)"
                  type="text"
                  inputmode="numeric"
                  placeholder="0"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('detailSteps', t) }"
                />
                <span class="hint">0 = inherit main generation</span>
              </label>
              <label>
                <span>Detail CFG</span>
                <input
                  :value="numberInput(form.detailCfg)"
                  type="text"
                  inputmode="numeric"
                  placeholder="-1"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('detailCfg', t) }"
                />
                <span class="hint">-1 = inherit main generation</span>
              </label>
              <label>
                <span>Detail Sampler</span>
                <input
                  :value="form.detailSampler ?? ''"
                  type="text"
                  placeholder="Inherit"
                />
              </label>
              <label>
                <span>Detail Scheduler</span>
                <input
                  :value="form.detailScheduler ?? ''"
                  type="text"
                  placeholder="Inherit"
                />
              </label>
              <label>
                <span>CLIP Skip</span>
                <input
                  :value="numberInput(form.clipSkip)"
                  type="text"
                  inputmode="numeric"
                  placeholder="Inherit"
                  @input="(e: Event) => { const t = (e.target as HTMLInputElement).value; onNumberInput('clipSkip', t) }"
                />
              </label>
            </div>
          </details>
        </div>
      </div>

      <footer class="dialog-footer">
        <button class="btn" @click="cancel()">Cancel</button>
        <button class="btn primary" :disabled="applied" @click="save()">Save</button>
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
}

.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-dim);
}

.default-tag {
  background: var(--accent);
  color: #fff;
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

.status-dl {
  background: #1e40af;
  color: #bfdbfe;
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

/* Options */
.options-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
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

.option-grid input[type="text"],
.option-grid select {
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

.checkbox-label,
.textarea-label {
  display: flex;
  gap: 4px;
}

.checkbox-label {
  flex-direction: row;
  align-items: center;
}

.option-grid .checkbox-label {
  flex-direction: row !important;
  align-items: center !important;
}

.checkbox-label span {
  font-size: 13px;
}

.checkbox-label input[type="checkbox"] {
  width: auto;
}

.textarea-label textarea {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}

.full-width {
  grid-column: 1 / -1;
}

/* Reset button */
.reset-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.reset-btn:hover {
  color: var(--text);
  border-color: var(--text-dim);
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
