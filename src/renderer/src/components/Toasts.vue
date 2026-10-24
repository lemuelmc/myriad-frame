<script setup lang="ts">
import { ref } from 'vue'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'ok'
}

const toasts = ref<Toast[]>([])
let nextId = 1

function push(text: string, kind: Toast['kind'] = 'info', ttl = 5000): void {
  const id = nextId++
  toasts.value.push({ id, text, kind })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, ttl)
}

// expose a global toast helper for stores/components
;(window as unknown as { __toast?: (t: string, k?: Toast['kind']) => void }).__toast = (t, k) => push(t, k)
</script>

<template>
  <div class="toasts">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
  </div>
</template>
