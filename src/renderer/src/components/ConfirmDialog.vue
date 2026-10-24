<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { settleConfirm, useConfirm } from '../confirm'

const { queue } = useConfirm()
const current = computed(() => queue.value[0] ?? null)
const confirmBtn = ref<HTMLButtonElement | null>(null)

function onKeydown(e: KeyboardEvent): void {
  if (!current.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    settleConfirm(false)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    settleConfirm(true)
  }
}

watch(
  () => current.value,
  (c) => {
    if (c) {
      window.addEventListener('keydown', onKeydown, true)
      // autofocus the confirm button so the dialog is operable by keyboard
      void nextTickFocus()
    } else {
      window.removeEventListener('keydown', onKeydown, true)
    }
  }
)

async function nextTickFocus(): Promise<void> {
  await nextTick()
  confirmBtn.value?.focus()
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div v-if="current" class="confirm-backdrop" @click.self="settleConfirm(false)">
    <div class="confirm-dialog" role="alertdialog" aria-modal="true" :aria-label="current.message">
      <p class="confirm-message">{{ current.message }}</p>
      <div class="confirm-actions">
        <button class="cancel" @click="settleConfirm(false)">{{ current.cancelLabel ?? 'Cancel' }}</button>
        <button ref="confirmBtn" class="primary" @click="settleConfirm(true)">{{ current.confirmLabel ?? 'OK' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1800;
}
.confirm-dialog {
  width: min(420px, 90vw);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.confirm-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
