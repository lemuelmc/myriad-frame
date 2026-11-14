<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useLightboxStore } from '../stores/lightbox'
import { useUpscalerStore } from '../stores/upscaler'
import { saveImageAs } from '../saveImage'

const store = useLightboxStore()
const upscalerStore = useUpscalerStore()

const fullSrc = ref('')
const loading = ref(false)
const resolution = ref('')
const closeBtn = ref<HTMLButtonElement | null>(null)

// Resolve the intrinsic resolution of the loaded image so the preview can
// show it (e.g. "1024x1024"). Only images carry a size; videos fall back to
// the empty state.
function measureResolution(src: string): void {
  const img = new Image()
  img.onload = () => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      resolution.value = `${img.naturalWidth}x${img.naturalHeight}`
    }
  }
  img.onerror = () => {
    resolution.value = ''
  }
  img.src = src
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // A higher upscaler layer (dialog / busy / compare) owns Escape while it
    // is open — it closes itself; the lightbox must stay underneath. (The
    // compare overlay stops us directly via stopImmediatePropagation; the
    // upscale dialog's listener registers AFTER ours, so this guard is what
    // saves us there.)
    if (upscalerStore.phase !== 'idle') return
    e.preventDefault()
    e.stopPropagation()
    store.close()
  }
}

async function focusClose(): Promise<void> {
  await nextTick()
  if (store.path) closeBtn.value?.focus()
}

// The component stays mounted for the app's lifetime, so the immediate first
// run sees store.path === null and must no-op (the else branch is a harmless
// no-op at that point).
watch(
   () => store.path,
   async (path) => {
     if (path) {
       document.body.style.overflow = 'hidden'
       window.addEventListener('keydown', onKeydown, true)
       loading.value = true
       fullSrc.value = ''
       resolution.value = ''
       void focusClose()
       try {
         const data = await window.api.imageFromPath(path)
         // The resolve can outlive the open (fast close + reopen of another
         // image): only apply if this resolve is still the current one.
         if (store.path === path) {
           fullSrc.value = data
           measureResolution(data)
         }
       } catch {
         // leave fullSrc empty → "image unavailable" fallback below
       } finally {
         if (store.path === path) loading.value = false
       }
     } else {
       document.body.style.overflow = ''
       window.removeEventListener('keydown', onKeydown, true)
     }
   },
   { immediate: true }
 )

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.path"
      class="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      @click="store.close()"
    >
      <button
        ref="closeBtn"
        class="icon lightbox-close"
        title="Close"
        aria-label="Close"
        @click.stop="store.close()"
      >
        ×
      </button>
      <div class="lightbox-stage" @click.stop>
        <img v-if="fullSrc" :src="fullSrc" alt="generated image" />
        <div v-else-if="loading" class="lightbox-status mono">loading…</div>
        <div v-else class="lightbox-status lightbox-missing mono">image unavailable</div>
      </div>
      <div class="lightbox-bottom" @click.stop>
        <button
          class="icon lightbox-tool"
          title="Save image as…"
          aria-label="Save image as"
          :disabled="!fullSrc"
          @click="saveImageAs(store.path!)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
        </button>
        <button
          class="icon lightbox-tool"
          title="Upscale image…"
          aria-label="Upscale image"
          :disabled="!fullSrc"
          @click="upscalerStore.openDialog(store.path!)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        </button>
        <div v-if="$slots.tools" class="tools-strip">
          <slot name="tools"></slot>
        </div>
        <div v-if="resolution" class="lightbox-resolution mono">{{ resolution }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2500;
  background: rgba(10, 12, 16, 0.92);
  display: flex;
  flex-direction: column;
  padding: 32px 24px 20px;
  gap: 14px;
}
.lightbox-close {
  position: absolute;
  top: 14px;
  right: 16px;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  font-size: 18px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
}
.lightbox-close:hover {
  background: rgba(0, 0, 0, 0.7);
}
.lightbox-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.lightbox-stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius);
}
.lightbox-status {
  color: var(--text-faint);
  padding: 12px;
}
.lightbox-missing {
  border: 1px dashed var(--border);
  width: 160px;
  text-align: center;
  border-radius: var(--radius);
}
.lightbox-bottom {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.lightbox-tool {
  padding: 0;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
}
.lightbox-tool:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.7);
}
.tools-strip {
  flex-shrink: 0;
}
.lightbox-resolution {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  padding: 0 8px;
}
</style>
