<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CatalogEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { matchesSearch, providerLabel } from '../search'
import { accessForFamily } from '../deps'
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
const search = computed(() => query.value.trim().toLowerCase())

/** One picker row: a plain single-file model OR a MoE group (groupId). */
interface PickerRow {
  key: string
  /** the selectable entry (the low-noise expert; the only member for plain rows) */
  primary: CatalogEntry
  /** every file of the row — the group members, or [primary] for plain rows */
  members: CatalogEntry[]
  /** display label — the group's shared label with the noise suffix stripped */
  label: string
  /** true when the row groups a MoE pair */
  isMoe: boolean
}

/** Group catalog entries into picker rows: entries sharing a `groupId` (a
 *  WAN MoE pair) collapse into ONE row whose primary is the low-noise
 *  expert; plain single-file entries keep one row each. */
function groupEntries(list: CatalogEntry[]): PickerRow[] {
  const groups = new Map<string, CatalogEntry[]>()
  const ordered: string[] = []
  for (const e of list) {
    const key = e.groupId ?? `id:${e.id}`
    if (!groups.has(key)) {
      groups.set(key, [])
      ordered.push(key)
    }
    groups.get(key)!.push(e)
  }
  const out: PickerRow[] = []
  for (const key of ordered) {
    const members = groups.get(key)!
    const primary = members.find((e) => e.useAs === 'diffusion-model') ?? members[0]
    const raw = primary.label || primary.name
    out.push({
      key,
      primary,
      members,
      label: raw.replace(/\s*\((?:low|high) noise\)$/i, ''),
      isMoe: !!primary.groupId
    })
  }
  return out
}

const totalCount = computed(() => groupEntries(diffusionEntries.value).length)

// Rows sorted stably by diffusionType → provider → name: raw catalog order is
// hub.json order followed by HF tree order, which is not stable across scans.
const rows = computed<PickerRow[]>(() => {
  const q = search.value
  const list = diffusionEntries.value.filter((e) => !q || matchesSearch(e, q, hubProviders.value))
  return groupEntries(list).sort((a, b) => {
    const pa = a.primary
    const pb = b.primary
    const family = pa.diffusionType.localeCompare(pb.diffusionType)
    if (family !== 0) return family
    const provider = providerLabel(pa.provider, hubProviders.value).localeCompare(
      providerLabel(pb.provider, hubProviders.value)
    )
    if (provider !== 0) return provider
    return pa.name.localeCompare(pb.name)
  })
})

function baseName(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * Access badge for the row's diffusion family, from the FRESH hub config
 * (`model_families[].access` via accessForFamily()): 'Auth' when downloads
 * need an API token, 'Gated' when a token AND accepting the terms/license on
 * the model page are required, null when freely downloadable. Rendered in
 * the same accent style as the CivitAI source badge — which is suppressed
 * while an access badge shows, since the access badge already covers the
 * token requirement.
 */
function accessBadge(e: CatalogEntry): 'Auth' | 'Gated' | null {
  const a = accessForFamily(e.diffusionType)
  if (!a) return null
  return a === 'gated' ? 'Gated' : 'Auth'
}

/** Hover text for the access badge — what it requires + where to configure the token. */
function accessTitle(e: CatalogEntry): string {
  return accessForFamily(e.diffusionType) === 'gated'
    ? 'Gated model — requires a token AND accepting the terms/license on the model page. Configure a token (Settings → Tokens)'
    : 'Requires authentication — configure a token (Settings → Tokens)'
}

/** Format an on-disk size in bytes as a human-readable string, matching the
 * Models section's fmtBytes in SettingsDialog.vue. */
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

/**
 * Installed state comes from `settingsStore.modelLists.diffusion` (refreshed
 * on mount and again by `downloadModel`'s finally-block) — not ChatPanel's
 * local `installedModels`, which this dialog cannot see. The `?? []` guard is
 * required, not stylistic: the dialog renders before the mount-await resolves
 * and `modelLists` starts as an empty object, so an unguarded `.some()` would
 * throw on first paint.
 */
/** A row is installed when EVERY member file is on disk (a MoE pair is not
 *  optional — gen:start fails on a missing high-noise companion). */
function isInstalled(row: PickerRow): boolean {
  return row.members.every((e) =>
    (settingsStore.modelLists.diffusion ?? []).some((f) => f.name === baseName(e.name))
  )
}
function isDownloading(row: PickerRow): boolean {
  return row.members.some((e) => !!settingsStore.modelDownloads[`diffusion:${e.url}`])
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
          <ul class="model-list">
            <li
              v-for="row in rows"
              :key="row.key"
              class="model-item"
              :class="{ selected: selected?.id === row.primary.id }"
              :title="row.primary.name"
              @click="emit('select', row.primary)"
            >
              <div class="item-main">
                <div class="title-row">
                  <span class="mono model-name">{{ baseName(row.label) }}</span>
                  <span class="tag">{{ row.primary.diffusionType }}</span>
                  <span v-if="row.primary.quant" class="tag">{{ row.primary.quant }}</span>
                  <span
                    v-if="row.isMoe"
                    class="tag"
                    title="MoE pair — both the low-noise and high-noise experts are required and download together"
                  >MoE</span>
                  <span
                    v-if="accessBadge(row.primary)"
                    class="tag auth-tag"
                    :title="accessTitle(row.primary)"
                  >{{ accessBadge(row.primary) }}</span>
                  <span
                    v-else-if="row.primary.source === 'civitai'"
                    class="tag auth-tag"
                    title="Downloads from CivitAI — requires a CivitAI API token (Settings → Tokens)"
                  >Auth</span>
                  <span v-if="isDownloading(row)" class="status-tag status-dl">Downloading…</span>
                  <span v-else-if="isInstalled(row)" class="status-tag status-ok">Downloaded</span>
                  <span v-else class="status-tag status-none">Not Downloaded</span>
                </div>
                <div class="item-sub">
                  <span class="provider">{{ providerLabel(row.primary.provider, hubProviders) }}</span>
                  <span v-if="row.primary.size" class="faint"> · {{ fmtBytes(row.primary.size) }}</span>
                  <template v-if="row.primary.description">
                    <span class="sep">·</span>
                    <span class="desc">{{ row.primary.description }}</span>
                  </template>
                </div>
              </div>
              <button
                class="set-default"
                :class="{ active: selected?.id === row.primary.id }"
                @click.stop="emit('select', row.primary)"
              >
                {{ selected?.id === row.primary.id ? 'Selected' : 'Select' }}
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
/* Auth/access marker — accent-colored so it stands out from the neutral
   family/quant tags. Covers BOTH the CivitAI source badge and the hub.json
   `access` badge ('Auth' / 'Gated'). Hover for what it requires and where
   to configure the token. */
.tag.auth-tag {
  color: var(--accent);
  border-color: var(--accent);
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
