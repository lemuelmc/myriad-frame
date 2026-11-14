<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { Session } from '@shared/types'
import { useGenerationStore } from '../stores/generation'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../toast'
import { confirm } from '../confirm'
import { normalizeForSearch } from '../search'
import logoTiny from '../../../assets/logo-square-tiny.png'

defineProps<{ width: number }>()
const emit = defineEmits<{ openSettings: [] }>()

const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()
const genStore = useGenerationStore()
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameEl = ref<HTMLInputElement | null>(null)
const creating = ref(false)
const newName = ref('')
const newNameEl = ref<HTMLInputElement | null>(null)
let confirming = false
const searchInput = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const searchNeedle = computed(() => normalizeForSearch(searchQuery.value).trim())

const filteredSessions = computed(() => {
  const needle = searchNeedle.value
  if (!needle) return sessionsStore.sessions
  return sessionsStore.sessions.filter((s) => matchesSessionSearch(s, needle))
})

function matchesSessionSearch(s: Session, needle: string): boolean {
  if (normalizeForSearch(s.name).includes(needle)) return true
  return s.messages.some((m) => normalizeForSearch(m.text).includes(needle))
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    searchQuery.value = ''
    ;(e.currentTarget as HTMLInputElement).blur()
  }
}
function clearSearch(): void {
  searchQuery.value = ''
  searchInput.value?.focus()
}

function onSelectSession(id: string): void {
  sessionsStore.select(id)
  searchQuery.value = ''
}

function startCreate(): void {
  newName.value = `Session ${sessionsStore.sessions.length + 1}`
  creating.value = true
  void nextTick(() => {
    newNameEl.value?.focus()
    newNameEl.value?.select()
  })
}

async function confirmCreate(): Promise<void> {
  if (confirming) return
  confirming = true

  const name = newName.value.trim()
  creating.value = false
  if (!name) {
    confirming = false
    return
  }
  try {
    await sessionsStore.create(name)
  } catch (err) {
    toast(`Failed to create session: ${(err as Error).message}`, 'error')
  } finally {
    confirming = false
  }
}

function cancelCreate(): void {
  creating.value = false
}

function startRename(id: string, current: string): void {
  renamingId.value = id
  renameValue.value = current
  void nextTick(() => {
    renameEl.value?.focus()
    renameEl.value?.select()
  })
}

async function confirmRename(): Promise<void> {
  const id = renamingId.value
  renamingId.value = null
  if (id && renameValue.value.trim()) {
    try {
      await sessionsStore.rename(id, renameValue.value.trim())
    } catch (err) {
      toast(`Failed to rename session: ${(err as Error).message}`, 'error')
    }
  }
}

async function removeSession(id: string, name: string): Promise<void> {
  const ok = await confirm(`Delete session "${name}"? This cannot be undone.`, {
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel'
  })
  if (!ok) return
  try {
    await sessionsStore.remove(id)
  } catch (err) {
    toast(`Failed to delete session: ${(err as Error).message}`, 'error')
  }
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <aside class="sidebar" :style="{ width: width + 'px' }">
    <header class="sidebar-header">
      <div class="brand">
        <img :src="logoTiny" alt="Myriad Frame" class="brand-logo" />
        <span class="brand-name">Myriad Frame</span>
      </div>
    </header>

    <div class="sessions">
      <div class="sessions-bar">
        <span class="muted">Sessions</span>
        <div class="search-wrap">
          <input
            ref="searchInput"
            v-model="searchQuery"
            class="session-search"
            type="text"
            placeholder="Search…"
            autocomplete="off"
            @keydown="onSearchKeydown"
          />
          <button
            v-if="searchQuery"
            class="icon session-search-clear"
            type="button"
            title="Clear search"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <button class="icon" title="New session" @click="startCreate()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div v-if="creating" class="new-session">
        <input
          ref="newNameEl"
          v-model="newName"
          class="rename-input"
          placeholder="Session name"
          @click.stop
          @keyup.enter="confirmCreate()"
          @blur="confirmCreate()"
        />
        <button class="icon" title="Cancel" @click.stop="cancelCreate()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <ul class="session-list">
        <li
          v-for="s in filteredSessions"
          :key="s.id"
          class="session"
          :class="{ active: s.id === sessionsStore.activeId }"
          @click="onSelectSession(s.id)"
        >
          <template v-if="renamingId === s.id">
            <input
              ref="renameEl"
              v-model="renameValue"
              class="rename-input"
              @click.stop
              @keyup.enter="confirmRename()"
              @blur="confirmRename()"
            />
          </template>
          <template v-else>
            <div class="session-name" @dblclick.stop="startRename(s.id, s.name)">{{ s.name }}</div>
            <div class="session-meta faint">
              <!-- Tiny busy badge while a generation runs in this session —
                   visible even when the session is NOT the active one
                   (plans/session-switch-busy-state.md). -->
              <span v-if="genStore.gens[s.id]" class="gen-dot" title="Generating…"></span>
              {{ fmtDate(s.updatedAt) }} · {{ s.messages.length }} msg
            </div>
          </template>
          <div class="session-actions" @click.stop>
            <button class="icon" title="Rename" @click="startRename(s.id, s.name)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
            <button class="icon" title="Delete" @click="removeSession(s.id, s.name)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
              </svg>
            </button>
          </div>
        </li>
        <li v-if="filteredSessions.length === 0 && sessionsStore.sessions.length > 0" class="empty muted">
          No sessions match "{{ searchQuery }}".
        </li>
        <li v-else-if="sessionsStore.sessions.length === 0" class="empty muted">
          No sessions yet. Create one to start.
        </li>
      </ul>
    </div>

    <footer class="sidebar-footer">
      <button class="icon" title="Settings" @click="emit('openSettings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
          />
        </svg>
      </button>
      <!-- Standard busy-downloading indicator: a small animated download-arrow
           glyph shown while ANY download is actively transferring (models,
           runtime, LLM runtime). Paused queues do not animate it. -->
      <div
        v-if="settingsStore.busyDownloading"
        class="busy-download"
        :title="`Downloading ${settingsStore.activeDownloadCount} file${settingsStore.activeDownloadCount === 1 ? '' : 's'}…`"
      >
        <svg class="busy-download-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 19h16" />
        </svg>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  overflow: hidden;
}
.sidebar-header {
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
}
.brand-logo {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}
.sessions {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sessions-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0 8px;
  overflow-y: auto;
  flex: 1;
}
.session {
  position: relative;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
}
.session:hover {
  background: var(--bg-hover);
}
.session.active {
  background: var(--bg-panel);
  box-shadow: inset 2px 0 0 var(--accent);
}
.session-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-meta {
  font-size: 11px;
  margin-top: 2px;
}
/* Per-session busy badge: a mini spinner on the meta line of any session
   with a generation in flight (currentColor follows the row's text tone). */
.gen-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  vertical-align: -1px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: gen-dot-spin 0.9s linear infinite;
}
@keyframes gen-dot-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gen-dot {
    animation: none;
  }
}
.session-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: none;
  gap: 2px;
  background: var(--bg-panel);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.session:hover .session-actions {
  display: flex;
}
.session:hover .session-name,
.session:hover .session-meta {
  padding-right: 60px;
}
.rename-input {
  width: 100%;
  font-size: 13px;
  padding: 3px 6px;
}
.new-session {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px 2px;
}
.new-session .rename-input {
  flex: 1;
  min-width: 0;
}
.search-wrap {
  flex: 1;
  position: relative;
  margin: 0 4px;
  min-width: 0;
}
.session-search {
  width: 100%;
  padding: 4px 26px 4px 8px;
  background: var(--bg-panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 12px;
}
.session-search:focus {
  outline: none;
  border-color: var(--accent, var(--border));
}
.session-search-clear {
  position: absolute;
  top: 50%;
  right: 3px;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
}
.session-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.session-search-clear:focus-visible {
  outline: 2px solid var(--accent, var(--border));
  outline-offset: -2px;
}
.session-search-clear:active {
  transform: translateY(-50%) scale(0.92);
}
.empty {
  padding: 12px 10px;
  font-size: 12px;
}
.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.busy-download {
  display: flex;
  align-items: center;
  color: var(--accent);
  opacity: 0.9;
}
.busy-download-icon {
  animation: busy-download-pulse 1.1s ease-in-out infinite;
}
@keyframes busy-download-pulse {
  0%,
  100% {
    transform: translateY(-1px);
    opacity: 0.55;
  }
  50% {
    transform: translateY(1px);
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .busy-download-icon {
    animation: none;
  }
}
</style>
