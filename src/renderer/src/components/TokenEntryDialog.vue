<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TokenEntry } from '@shared/types'
import { toast } from '../toast'

/**
 * Add/Edit dialog for a single token entry (Settings → Tokens), following the
 * ModelPickerDialog pattern: props in, emits out, overlay, Esc-to-close.
 *
 * `entry === null` → add mode (tokens:add); non-null → edit mode
 * (tokens:update with the entry's key — the source/repo fields are pre-filled
 * but DISABLED, because the key is the update target and cannot change).
 * The token field always starts EMPTY in both modes: the raw token is never
 * sent to the renderer by tokens:list (masked only), so there is nothing to
 * pre-fill — saving replaces the stored value.
 */
const props = defineProps<{ entry: TokenEntry | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const isEdit = computed(() => props.entry !== null)

const sources = ref<string[]>([])
const source = ref(props.entry?.source ?? '')
const repoPattern = ref(props.entry?.repoPattern ?? '')
const token = ref('')
const reveal = ref(false)
const tokenEl = ref<HTMLInputElement | null>(null)
const saving = ref(false)

/**
 * Client-side mirror of validateTokenPattern() in
 * src/main/services/sources/tokens.ts — THE AUTHORITY, which main re-runs on
 * save (addToken). Mirrored here purely for real-time feedback; no IPC
 * round-trip per keystroke. The value is trimmed BEFORE validation, matching
 * the UI write path (addToken trims too); only the disk READ path
 * (readTokens) validates raw so hand-edit typos surface as warns.
 * Returns '' when valid, the error message otherwise.
 */
function patternError(raw: string): string {
  const p = raw.trim()
  if (!p) return 'Repo pattern is required'
  if (p.includes('*')) {
    const starIdx = p.indexOf('*')
    if (starIdx !== p.length - 1) return 'Wildcard (*) can only appear at the end of a pattern'
    if (starIdx > 0 && p[starIdx - 1] !== '/') {
      return 'Wildcard (*) must follow a "/" (e.g. "org/*") or be alone ("*")'
    }
    if (starIdx > 0) {
      const prefix = p.slice(0, starIdx - 1)
      if (!prefix || prefix.endsWith('/') || !/^[a-zA-Z0-9_\-/.]+$/.test(prefix)) {
        return 'Wildcard prefix must be a repo path (allow: a-z, A-Z, 0-9, -, _, ., /)'
      }
    }
  }
  if (!p.includes('*') && !/^[a-zA-Z0-9_\-/.]+$/.test(p)) {
    return 'Repo pattern contains invalid characters (allow: a-z, A-Z, 0-9, -, _, ., /)'
  }
  return ''
}

const patternErr = computed(() => patternError(repoPattern.value))

/**
 * Live pattern-type caption under the repo field. The partial-wildcard
 * caption distinguishes the prefix SHAPE (source-agnostic): "org-level" for
 * a single-segment prefix ("org/*") vs "nested" for a multi-segment one
 * ("a/b/*"). On HuggingFace the nested form can never match (repo slugs are
 * exactly org/repo) — a harmless dead entry; see the HF slug reality note in
 * plans/wildcard-token-keys.md.
 */
const patternCaption = computed(() => {
  const p = repoPattern.value.trim()
  if (!p) return ''
  if (p === '*') {
    return 'Full wildcard (ALL repos — a bad token here affects public downloads too)'
  }
  if (p.endsWith('/*')) {
    const shape = p.slice(0, -2).includes('/') ? 'nested' : 'org-level'
    return `Partial wildcard (${shape})`
  }
  return 'Exact match'
})

const canSave = computed(() => !!source.value.trim() && !patternErr.value && !!token.value.trim())

async function save(): Promise<void> {
  const src = source.value.trim()
  const pat = repoPattern.value.trim()
  if (!src) {
    toast('Source name is required', 'error')
    return
  }
  const perr = patternError(pat)
  if (perr) {
    toast(perr, 'error')
    return
  }
  if (!token.value.trim()) {
    toast('Token value is required', 'error')
    return
  }
  saving.value = true
  try {
    if (props.entry) {
      await window.api.tokensUpdate(props.entry.key, token.value)
    } else {
      await window.api.tokensAdd({ source: src, repoPattern: pat, token: token.value })
    }
    // Success toast BEFORE clearing the token field so the user gets the
    // confirmation first; clearing afterwards reduces the token's exposure
    // in the input.
    toast(props.entry ? `Token updated for ${props.entry.key}` : `Token added: ${src}:${pat}`, 'ok')
    token.value = ''
    emit('saved')
    emit('close')
  } catch (err) {
    // Handler rejection (duplicate key, invalid pattern, unknown source):
    // surface it and stay open so the input can be corrected.
    toast((err as Error).message, 'error')
  } finally {
    saving.value = false
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
  // Esc-to-close via a capture listener, the ModelPickerDialog pattern.
  // Registered before the first await so Esc works even while the source
  // list is being fetched.
  window.addEventListener('keydown', onKeydown, true)
  // Registered source NAMES (deduped by the registry — domains and names are
  // both registry keys) for the dropdown.
  try {
    sources.value = await window.api.sourcesList()
  } catch {
    sources.value = []
  }
  if (!isEdit.value && !source.value) source.value = sources.value[0] ?? ''
  await nextTick()
  tokenEl.value?.focus()
})

// This dialog is v-if mounted/unmounted by SettingsDialog, so
// onBeforeUnmount is the only cleanup point — skipping it would leak the
// capture listener.
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="isEdit ? 'Edit Token Entry' : 'Add Token Entry'"
    >
      <header class="dialog-header">
        <h2>{{ isEdit ? 'Edit Token Entry' : 'Add Token Entry' }}</h2>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <label for="token-source">Source</label>
        <select id="token-source" v-model="source" :disabled="isEdit">
          <option v-if="source && !sources.includes(source)" :value="source">
            {{ source }} (unregistered)
          </option>
          <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
        </select>

        <label for="token-repo">Repo pattern</label>
        <input
          id="token-repo"
          v-model="repoPattern"
          type="text"
          :disabled="isEdit"
          placeholder='e.g. "unsloth/Qwen-Image-2.1-GGUF", "unsloth/*", or "*"'
          spellcheck="false"
          autocomplete="off"
          class="mono"
        />
        <p v-if="patternErr" class="field-err">{{ patternErr }}</p>
        <p v-else-if="patternCaption" class="field-hint">{{ patternCaption }}</p>

        <label for="token-value">Token</label>
        <div class="token-row">
          <input
            id="token-value"
            ref="tokenEl"
            v-model="token"
            :type="reveal ? 'text' : 'password'"
            placeholder="hf_…"
            spellcheck="false"
            autocomplete="off"
            class="mono"
          />
          <button
            type="button"
            class="dl-btn"
            :title="reveal ? 'Hide token' : 'Reveal token'"
            @click="reveal = !reveal"
          >
            {{ reveal ? 'Hide' : 'Show' }}
          </button>
        </div>
        <p v-if="isEdit" class="field-hint">
          The stored value is never shown. Saving replaces it with what you type here.
        </p>

        <div class="dialog-actions">
          <button :disabled="saving" @click="emit('close')">Cancel</button>
          <button class="primary" :disabled="saving || !canSave" @click="save()">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
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
  z-index: 1600;
}
.dialog {
  width: min(460px, 92vw);
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
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 {
  margin: 0;
  font-size: 16px;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
}
.dialog-body label {
  margin: 10px 0 4px;
  font-size: 13px;
}
.dialog-body label:first-of-type {
  margin-top: 0;
}
.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.token-row input {
  flex: 1;
  min-width: 0;
}
.field-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}
.field-err {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--danger);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.dialog-actions .primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
</style>
