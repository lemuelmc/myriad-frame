<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
/**
 * LoRA browser — the shared hub-LoRA management UI used by BOTH hosts:
 * Settings → LoRA (the whole section) and the chat panel's LoraDialog (the
 * management half below the per-session settings). Self-contained on purpose:
 * it reads `appStore.catalog` + `settingsStore` directly and performs its own
 * download/redownload/delete actions, so embedding it anywhere is a one-liner
 * (plans/lora-support.md §8.1).
 *
 * Rows mirror the Models section's action set: Download / Downloading… (with
 * live progress) / installed → force Redownload, plus an Installed list with
 * Delete. Installed rows are read-only otherwise — LoRA activation is
 * prompt-driven (`<lora:filename:weight>` tags typed by the user, see
 * LoraDialog's hint), so there is deliberately no per-LoRA enable/weight
 * state here.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { CatalogEntry, ModelFile } from '@shared/types'
import { DOWNLOAD_ABORTED_MESSAGE } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { baseName, matchesSearch, providerLabel } from '../search'
import { confirm } from '../confirm'
import { toast } from '../toast'
import DownloadProgress from './DownloadProgress.vue'

const appStore = useAppStore()
const settingsStore = useSettingsStore()

const hubProviders = computed(() => appStore.configs?.hub.providers ?? [])

// ---------- diffusion-type filter ----------
// Distinct diffusion types that have lora entries in the catalog. An entry
// appears under EVERY type in its hub.json `families` (the catalog
// loop expands one row per member), so filtering by the selected type is an
// exact per-type list.
const loraTypes = computed(() =>
  [...new Set((appStore.catalog?.entries ?? []).filter((e) => e.type === 'lora').map((e) => e.diffusionType))].sort(
    (a, b) => a.localeCompare(b)
  )
)
const selectedType = ref('')
// Keep the selection valid across rescans: follow the first type when the
// current selection vanishes (catalog refreshed without it) or is still unset.
watch(
  loraTypes,
  (types) => {
    if (!types.includes(selectedType.value)) selectedType.value = types[0] ?? ''
  },
  { immediate: true }
)

// ---------- search ----------
const query = ref('')

const loraEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'lora' && e.diffusionType === selectedType.value)
)

const providerGroups = computed<[string, CatalogEntry[]][]>(() => {
  const q = query.value.trim()
  const hit = q ? loraEntries.value.filter((e) => matchesSearch(e, q, hubProviders.value)) : loraEntries.value
  const map = new Map<string, CatalogEntry[]>()
  for (const e of hit) {
    const key = providerLabel(e.provider, hubProviders.value)
    const list = map.get(key) ?? []
    list.push(e)
    map.set(key, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entries]) => [provider, [...entries].sort((a, b) => a.label.localeCompare(b.label))])
})

// ---------- installed ----------
// `?? []` is required, not stylistic: the component renders before the
// mount-await resolves and `modelLists` starts as an empty object (the same
// first-paint guard ModelPickerDialog documents for its `.some()`).
const installedFiles = computed(() => settingsStore.modelLists.lora ?? [])
const installedNames = computed(() => new Set(installedFiles.value.map((f) => f.name)))

function isInstalled(e: CatalogEntry): boolean {
  // Permissive basename compare (model-collision-hardening plan §6) — LoRA
  // names are already basenames, but the normalization keeps the check
  // aligned with every other installed-state site.
  return installedNames.value.has(baseName(e.name))
}
function dlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`lora:${e.url}`]
}

// ---------- actions ----------
async function downloadEntry(e: CatalogEntry, force = false): Promise<void> {
  try {
    await settingsStore.downloadModel('lora', e.url, e.provider, force)
    toast(`${force ? 'Redownloaded' : 'Downloaded'} ${e.name}`, 'ok')
  } catch (err) {
    // Deliberate cancel (Downloads section / Pause) — already toasted by the
    // canceling action; not a failure.
    if ((err as Error).message !== DOWNLOAD_ABORTED_MESSAGE) {
      toast(`Download failed: ${(err as Error).message}`, 'error')
    }
  }
}

/** Context-scoped delete (one path — the row's provider dir). */
async function removeLora(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('lora', f.name, f.provider, f.diffusionType)
}

async function refreshHub(): Promise<void> {
  try {
    await appStore.refreshCatalog()
  } catch (err) {
    toast(`Hub refresh failed: ${(err as Error).message}`, 'error')
  }
}

/**
 * Copy a ready-to-paste prompt tag for an installed LoRA. sd-cli resolves the
 * tag's filename against --lora-model-dir; the extension-stripped stem is the
 * conventional form (the hint in LoraDialog stays generic about it).
 */
async function copyTag(name: string): Promise<void> {
  const stem = name.replace(/\.(safetensors|gguf)$/i, '')
  try {
    await navigator.clipboard.writeText(`<lora:${stem}:1.0>`)
    toast(`Copied <lora:${stem}:1.0>`, 'ok')
  } catch {
    toast('Copy failed — select the file name manually', 'error')
  }
}

function fmtBytes(n: number): string {
  if (!n) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

onMounted(async () => {
  await settingsStore.listModels('lora')
})
</script>

<template>
  <div class="lora-browser">
    <div class="section-head">
      <h3>LoRA</h3>
      <button :disabled="appStore.catalogScanning" @click="refreshHub()">
        {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
      </button>
    </div>
    <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>
    <div v-if="appStore.catalogScanning" class="progress indeterminate">
      <div class="progress-fill"></div>
    </div>

    <label class="muted type-label">Diffusion type</label>
    <select v-model="selectedType" title="Filter LoRAs by diffusion type">
      <option v-for="t in loraTypes" :key="t" :value="t">{{ t }}</option>
    </select>
    <input
      v-model="query"
      class="lora-search"
      type="text"
      placeholder="Filter LoRA — space, '-' and '_' are equivalent"
    />

    <h4>Available from hub</h4>
    <div v-for="[provider, entries] in providerGroups" :key="provider" class="provider-group">
      <h5>{{ provider }}</h5>
      <ul class="file-list">
        <li v-for="e in entries" :key="e.id" class="dl-item">
          <div class="dl-item-top">
            <span class="mono" :title="e.name">{{ e.label || e.name }}</span>
            <span
              v-if="e.source === 'civitai'"
              class="auth-tag"
              title="Downloads from CivitAI — requires a CivitAI API token (Settings → Tokens)"
            >Auth</span>
            <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
            <template v-if="isInstalled(e)">
              <span class="ok-tag">installed</span>
              <button class="icon" title="Force redownload" :disabled="!!dlState(e)" @click="downloadEntry(e, true)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2v6h-6M3 22v-6h6" />
                  <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                </svg>
              </button>
            </template>
            <template v-else>
              <button
                v-if="dlState(e)"
                class="dl-btn"
                disabled
                :title="`${dlState(e)!.downloadedBytes} / ${dlState(e)!.totalBytes} downloaded`"
              >
                Downloading…
              </button>
              <button v-else class="dl-btn" @click="downloadEntry(e)">Download</button>
            </template>
          </div>
          <div v-if="e.description" class="dl-item-desc">{{ e.description }}</div>
          <div v-if="e.name !== e.label" class="dl-item-file faint mono">{{ e.name }}</div>
          <DownloadProgress
            v-if="dlState(e)"
            class="grow"
            :downloaded-bytes="dlState(e)!.downloadedBytes"
            :total-bytes="dlState(e)!.totalBytes"
          />
        </li>
      </ul>
    </div>
    <p v-if="!loraEntries.length" class="muted">
      No LoRA entries in the catalog. Use "Refresh hub" to scan the repositories.
    </p>
    <p v-else-if="!providerGroups.length" class="muted">No LoRAs match "{{ query }}"</p>

    <h4>Installed</h4>
    <ul class="file-list">
      <li v-for="f in installedFiles" :key="`${f.diffusionType ?? ''}/${f.provider ?? ''}/${f.name}`">
        <span class="mono" :title="f.name">{{ f.name }}</span>
        <span v-if="f.provider" class="faint">{{ f.provider }}</span>
        <span class="faint">{{ fmtBytes(f.size) }}</span>
        <button class="icon" title="Copy prompt tag" @click="copyTag(f.name)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button class="dl-btn danger" @click="removeLora(f)">Delete</button>
      </li>
      <li v-if="!installedFiles.length" class="muted">No LoRAs installed yet.</li>
    </ul>
  </div>
</template>

<style scoped>
.lora-browser {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-head h3 {
  margin: 0;
}
.type-label {
  font-size: 13px;
}
.lora-browser select,
.lora-search {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  color: var(--text);
  font-size: 13px;
}
.lora-search {
  margin-bottom: 4px;
}
.provider-group h5 {
  margin: 10px 0 2px;
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.file-list {
  list-style: none;
  margin: 4px 0 8px;
  padding: 0;
}
.file-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.file-list li.dl-item {
  align-items: flex-start;
  flex-direction: column;
  gap: 4px;
}
.dl-item-top {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.dl-item-top .mono,
.file-list li .mono {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-item-desc {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.dl-item-file {
  width: 100%;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.auth-tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  color: var(--accent);
}
.ok-tag {
  color: var(--ok);
  font-size: 12px;
}
.dl-btn {
  padding: 3px 10px;
  font-size: 12px;
}
.dl-btn.danger {
  color: var(--danger);
}
.dl-btn.danger:hover {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.grow {
  width: 100%;
}
</style>
