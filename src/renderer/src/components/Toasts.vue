<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { ref } from 'vue'
import { type ToastAction, type ToastFn } from '../toast'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'ok'
  action?: ToastAction
}

const toasts = ref<Toast[]>([])
let nextId = 1

function push(
  text: string,
  kind: Toast['kind'] = 'info',
  ttl = 5000,
  action?: ToastAction
): void {
  const id = nextId++
  toasts.value.push({ id, text, kind, action })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, ttl)
}

// A clicked action has served its purpose — dismiss the toast immediately.
// The setTimeout scheduled by push keeps running and later filters an
// already-removed id, which is a harmless no-op (no timer cleanup needed).
function runAction(t: Toast): void {
  t.action?.run()
  toasts.value = toasts.value.filter((x) => x.id !== t.id)
}

// Explicit user dismiss (close button): the same removal the TTL timer
// performs. The scheduled timeout later filters an already-removed id —
// a harmless no-op, no timer cleanup needed.
function dismiss(t: Toast): void {
  toasts.value = toasts.value.filter((x) => x.id !== t.id)
}

// expose a global toast helper for stores/components
;(window as unknown as { __toast?: ToastFn }).__toast = (t, k, ttl, a) => push(t, k, ttl, a)
</script>

<template>
  <div class="toasts">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
      <span class="toast-text">{{ t.text }}</span>
      <button v-if="t.action" class="toast-action" @click="runAction(t)">
        {{ t.action.label }}
      </button>
      <button class="toast-close" aria-label="Dismiss" title="Dismiss" @click="dismiss(t)">
        ×
      </button>
    </div>
  </div>
</template>
