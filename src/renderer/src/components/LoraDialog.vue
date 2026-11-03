<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
/**
 * Per-session LoRA dialog (chat panel) — the "Lora" toolbar button's target.
 * Two halves:
 * 1. Session settings: the apply-mode dropdown (OFF / Auto / Immediately /
 *    At Runtime → sd-cli's --lora-apply-mode) and the custom --lora-model-dir
 *    override (native folder picker + Clear). Both persist via
 *    sessions.setInputs; 'off' emits NEITHER flag at spawn.
 * 2. The shared LoraBrowser — per the confirmed design, this dialog is also
 *    where users download / redownload / delete LoRAs.
 *
 * Deliberately NOT copied from SessionSamplingDialog: its diffusionType
 * computed (Object.keys(sampling)[0]) is wrong for this purpose — the dialog
 * needs no diffusion type at all; the embedded browser owns its own filter
 * (plans/lora-support.md §13.5).
 *
 * LoRA activation is prompt-driven (Option A): the user writes
 * `<lora:filename:weight>` tags in the prompt; the hint line below the
 * dropdown documents that. The dialog configures only WHERE sd-cli looks and
 * HOW adapters merge. The tag examples are interpolated from script constants
 * because a literal `<lora:...>` in template text parses as an element.
 */
import { nextTick, onBeforeUnmount, onMounted, reactive } from 'vue'
import type { LoraApplyMode, SessionLora } from '@shared/types'
import { useSessionsStore } from '../stores/sessions'
import LoraBrowser from './LoraBrowser.vue'

const props = defineProps<{ sessionName: string }>()
const emit = defineEmits<{ save: [draft: SessionLora | null]; close: [] }>()

const sessionsStore = useSessionsStore()

const draft = reactive<SessionLora>({
  mode: 'off',
  dir: undefined
})

const MODE_OPTIONS: { value: LoraApplyMode; label: string }[] = [
  { value: 'off', label: 'OFF' },
  { value: 'auto', label: 'Auto' },
  { value: 'immediately', label: 'Immediately' },
  { value: 'at_runtime', label: 'At Runtime' }
]

// Prompt-tag hint examples (interpolated — see the header comment).
const TAG_SYNTAX = '<lora:filename:weight>'
const TAG_EXAMPLE = '<lora:my_style_lora:0.8>'

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  // Prefill from the active session's saved config once the reactive sources
  // are populated. A session without a saved lora config starts at 'off' —
  // matching the toolbar button's inactive default.
  await nextTick()
  const saved = sessionsStore.active?.inputs?.lora
  draft.mode = saved?.mode ?? 'off'
  draft.dir = saved?.dir
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

async function browse(): Promise<void> {
  // Native folder picker shown by main; null = canceled, keep the current
  // draft untouched.
  const picked = await window.api.pickDirectory()
  if (picked) draft.dir = picked
}

function save(): void {
  const dir = draft.dir?.trim()
  emit('save', dir ? { mode: draft.mode, dir } : { mode: draft.mode })
}

function reset(): void {
  emit('save', null)
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="LoRA settings">
      <header class="dialog-header">
        <h2>LoRA</h2>
        <span class="muted faint">{{ props.sessionName }}</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <label class="kv-row">
          <span>LoRA loading</span>
          <select v-model="draft.mode">
            <option v-for="o in MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <p class="faint">
          Activate a LoRA by adding a <span class="mono">{{ TAG_SYNTAX }}</span> tag to the
          prompt — e.g. <span class="mono">{{ TAG_EXAMPLE }}</span>. The filename is a file
          inside the LoRA directory below; the weight defaults to 1.0.
        </p>

        <label class="kv-row">
          <span>LoRA directory</span>
          <input
            class="dir-display"
            type="text"
            readonly
            :value="draft.dir || ''"
            placeholder="Default (data/models/lora)"
            title="Custom directory passed to sd-cli's --lora-model-dir; empty uses the default data/models/lora store"
          />
        </label>
        <div class="dir-actions">
          <button @click="browse()">Browse…</button>
          <button v-if="draft.dir" @click="draft.dir = undefined">Clear</button>
        </div>
        <p class="faint">
          Empty uses the default <span class="mono">data/models/lora</span> store, where LoRAs
          downloaded below are kept. Clearing never deletes files.
        </p>

        <div class="browser-wrap">
          <LoraBrowser />
        </div>
      </div>

      <footer class="dialog-footer">
        <button @click="reset()">Reset</button>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" @click="save()">Save</button>
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
  z-index: 1500;
}
.dialog {
  /* Wider than the sampling dialog — the embedded browser needs the room. */
  width: min(720px, 94vw);
  max-height: 92vh;
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
.dialog-header .muted {
  margin-left: auto;
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
  overflow-y: auto;
}
.kv-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.kv-row > span {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-dim);
}
.kv-row select,
.kv-row input {
  flex: 1;
  min-width: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  color: var(--text);
  font-size: 13px;
}
.dir-display {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
}
.dir-actions {
  display: flex;
  gap: 8px;
}
.browser-wrap {
  border-top: 1px solid var(--border);
  padding-top: 10px;
  margin-top: 4px;
}
.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
</style>
