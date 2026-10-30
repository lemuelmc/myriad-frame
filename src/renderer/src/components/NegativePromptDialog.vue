<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionsStore } from '../stores/sessions'

const props = defineProps<{ sessionName: string }>()
const emit = defineEmits<{ save: [draft: string]; close: [] }>()

// Per-session negative prompt (empty ⇒ inherit the global default). Read fresh
// each time the dialog opens so a value saved in session A is not shown while
// session B is active, and the pre-fill reflects the latest saved value.
const sessionNegative = computed(() => useSessionsStore().active?.inputs?.negativePrompt ?? '')

const draft = ref('')
const el = ref<HTMLTextAreaElement | null>(null)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  await nextTick()
  // Pre-fill from the session's saved value so the dialog shows what the next
  // generation will use instead of always starting blank.
  draft.value = sessionNegative.value
  el.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

function clear(): void {
  emit('save', '')
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Negative prompt">
      <header class="dialog-header">
        <h2>Negative prompt</h2>
        <span class="muted faint">{{ props.sessionName }}</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <textarea
          ref="el"
          v-model="draft"
          rows="4"
          placeholder="(none — inherit the global default)"
        ></textarea>
        <p class="faint">
          Applies to this session only. Clear reverts to the global default
          negative prompt (Settings → Sampling).
        </p>
        <p class="faint">
          NOTE: Not all models support negative prompts.
        </p>
      </div>

      <footer class="dialog-footer">
        <button class="primary" @click="clear()">Clear</button>
        <button @click="emit('close')">Cancel</button>
        <button @click="emit('save', draft)">Save</button>
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
  width: min(560px, 92vw);
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
}
.dialog-body textarea {
  flex: 1;
  min-height: 96px;
  resize: vertical;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
}
.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.dialog-footer .primary {
  margin-left: auto;
}
</style>
