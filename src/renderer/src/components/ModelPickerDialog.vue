<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CatalogEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { matchesSearch, providerLabel } from '../search'
import { toast } from '../toast'

const props = defineProps<{ selected: CatalogEntry | null }>()
const emit = defineEmits<{ select: [entry: CatalogEntry]; close: [] }>()

const appStore = useAppStore()
const settingsStore = useSettingsStore()

const query = ref('')
const searchEl = ref<HTMLInputElement | null>(null)

// Providers come from the hub config; threaded explicitly into the shared
// search helpers (see ../search.ts).
const hubProviders = computed(() => appStore.configs?.hub.providers ?? [])

// Same row filter as ChatPanel's diffusionEntries: the diffusion loop in
// buildCatalog() scans every .gguf/.safetensors file in the repo tree,
// including text_encoders/ and vae/ subfolders, which must be excluded here
// or the table would list encoder/VAE files as selectable models.
const diffusionEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => {
    if (e.type !== 'diffusion') return false
    const lname = e.name.toLowerCase()
    // Exclude standalone VAE weights and LoRA adapters — neither is a selectable
    // diffusion checkpoint, even when scanned under a diffusion repo tree.
    if (lname.includes('vae') || lname.includes('lora') || lname.includes('text_encoders')) return false
    return !e.name.startsWith('text_encoders/') && !e.name.startsWith('vae/')
  })
)
const totalCount = computed(() => diffusionEntries.value.length)

const search = computed(() => query.value.trim().toLowerCase())

// Rows sorted stably by diffusionType → provider → name: raw catalog order is
// hub.json order followed by HF tree order, which is not stable across scans.
const rows = computed(() => {
  const q = search.value
  const list = diffusionEntries.value.filter((e) => !q || matchesSearch(e, q, hubProviders.value))
  return [...list].sort((a, b) => {
    const family = a.diffusionType.localeCompare(b.diffusionType)
    if (family !== 0) return family
    const provider = providerLabel(a.provider, hubProviders.value).localeCompare(
      providerLabel(b.provider, hubProviders.value)
    )
    if (provider !== 0) return provider
    return a.name.localeCompare(b.name)
  })
})

function baseName(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * Installed state comes from `settingsStore.modelLists.diffusion` (refreshed
 * on mount and again by `downloadModel`'s finally-block) — not ChatPanel's
 * local `installedModels`, which this dialog cannot see. The `?? []` guard is
 * required, not stylistic: the dialog renders before the mount-await resolves
 * and `modelLists` starts as an empty object, so an unguarded `.some()` would
 * throw on first paint.
 */
function isInstalled(e: CatalogEntry): boolean {
  return (settingsStore.modelLists.diffusion ?? []).some((f) => f.name === e.name)
}
function isDownloading(e: CatalogEntry): boolean {
  return !!settingsStore.modelDownloads[`diffusion:${e.url}`]
}

async function refreshHub(): Promise<void> {
  try {
    await appStore.refreshCatalog()
  } catch (err) {
    toast(`Hub refresh failed: ${(err as Error).message}`, 'error')
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(async () => {
  // Esc-to-close via a capture listener, the ImageLightbox / ConfirmDialog
  // pattern. Registered before the first await so Esc works even while the
  // model list is being fetched.
  window.addEventListener('keydown', onKeydown, true)
  // Fresh installed names so the Status column is accurate.
  await settingsStore.listModels('diffusion')
  // The v-if-mounted input doesn't exist until after mount.
  await nextTick()
  searchEl.value?.focus()
})

// This dialog is v-if mounted/unmounted by ChatPanel, so onBeforeUnmount is
// the only cleanup point — skipping it would leak the capture listener.
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Select a model">
      <header class="dialog-header">
        <h2>Select a model</h2>
        <span class="muted faint count">{{ rows.length }}/{{ totalCount }} models</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <input
          ref="searchEl"
          v-model="query"
          class="picker-search"
          type="text"
          placeholder="Search by name, family, quant, provider, description…"
        />

        <div v-if="!totalCount" class="empty-state">
          <p class="muted">No diffusion models in the catalog. Use "Refresh hub" to scan the repositories.</p>
          <button :disabled="appStore.catalogScanning" @click="refreshHub()">
            {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
          </button>
        </div>

        <p v-else-if="!rows.length" class="muted no-match">No models match "{{ query }}"</p>

        <div v-else class="list-wrap">
          <!-- Card-style rows instead of a dense table: the name owns the full
               first line (wraps instead of being ellipsized) and the provider +
               description share the full second line, so both stay readable at
               a glance. The whole row is clickable to select. -->
          <ul class="model-list">
            <li
              v-for="e in rows"
              :key="e.id"
              class="model-item"
              :class="{ selected: selected?.id === e.id }"
              :title="e.name"
              @click="emit('select', e)"
            >
              <div class="item-main">
                <div class="title-row">
                  <span class="mono model-name">{{ baseName(e.name) }}</span>
                  <span class="tag">{{ e.diffusionType }}</span>
                  <span v-if="e.quant" class="tag">{{ e.quant }}</span>
                  <span v-if="isDownloading(e)" class="status-tag status-dl">Downloading…</span>
                  <span v-else-if="isInstalled(e)" class="status-tag status-ok">Downloaded</span>
                  <span v-else class="status-tag status-none">Not Downloaded</span>
                </div>
                <div class="item-sub">
                  <span class="provider">{{ providerLabel(e.provider, hubProviders) }}</span>
                  <template v-if="e.description">
                    <span class="sep">·</span>
                    <span class="desc">{{ e.description }}</span>
                  </template>
                </div>
              </div>
              <!-- The currently selected entry stays clickable: picking it
                   assigns the identical entry reference (a watcher no-op)
                   and simply closes the dialog. -->
              <button
                class="set-default"
                :class="{ active: selected?.id === e.id }"
                @click.stop="emit('select', e)"
              >
                {{ selected?.id === e.id ? 'Selected' : 'Select' }}
              </button>
            </li>
          </ul>
        </div>
      </div>
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
  z-index: 1500;
}
.dialog {
  width: min(880px, 92vw);
  height: min(640px, 88vh);
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
  gap: 10px;
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
  gap: 10px;
}
.picker-search {
  flex-shrink: 0;
}
.list-wrap {
  flex: 1;
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
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.model-item:last-child {
  border-bottom: none;
}
.model-item:hover {
  background: var(--bg-hover);
}
.model-item.selected {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}
.item-main {
  flex: 1;
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  row-gap: 4px;
  flex-wrap: wrap;
}
.model-name {
  font-size: 13px;
  color: var(--text);
  /* Long filenames wrap instead of clipping — the name is the primary
     scanning key, so it must never be ellipsized away. */
  overflow-wrap: anywhere;
}
.tag {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  white-space: nowrap;
}
.status-tag {
  font-size: 11px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  color: var(--text-faint);
  white-space: nowrap;
}
.status-tag.status-dl {
  color: var(--accent);
  border-color: var(--accent);
}
.status-tag.status-ok {
  color: var(--ok);
  border-color: var(--ok);
}
.item-sub {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.item-sub .provider {
  font-weight: 600;
}
.item-sub .sep {
  margin: 0 5px;
  color: var(--text-faint);
}
.item-sub .desc {
  overflow-wrap: anywhere;
}
.set-default {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.set-default.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.set-default {
  padding: 3px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.set-default.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.empty-state {
  margin: auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.no-match {
  margin: 0;
  padding: 24px 0;
  text-align: center;
}
</style>
