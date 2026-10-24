<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useSessionsStore } from '../stores/sessions'
import { toast } from '../toast'
import { confirm } from '../confirm'
import logoTiny from '../../../assets/logo-square-tiny.png'

defineProps<{ width: number }>()
const emit = defineEmits<{ openSettings: [] }>()

const sessionsStore = useSessionsStore()
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameEl = ref<HTMLInputElement | null>(null)
const creating = ref(false)
const newName = ref('')
const newNameEl = ref<HTMLInputElement | null>(null)
let confirming = false

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
          v-for="s in sessionsStore.sessions"
          :key="s.id"
          class="session"
          :class="{ active: s.id === sessionsStore.activeId }"
          @click="sessionsStore.select(s.id)"
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
            <div class="session-meta faint">{{ fmtDate(s.updatedAt) }} · {{ s.messages.length }} msg</div>
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
        <li v-if="sessionsStore.sessions.length === 0" class="empty muted">
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
.empty {
  padding: 12px 10px;
  font-size: 12px;
}
.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
}
</style>
