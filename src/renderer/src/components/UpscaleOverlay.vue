<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUpscalerStore } from '../stores/upscaler'
import { saveImageAs } from '../saveImage'

const store = useUpscalerStore()

// Image data URLs (loaded from the main process).
const beforeSrc = ref('')
const afterSrc = ref('')
const beforeFailed = ref(false)
const afterFailed = ref(false)

// Compare slider position (0..100 percent of the display box width).
const slider = ref(50)
const compareBox = ref<HTMLDivElement | null>(null)
const dragging = ref(false)

function onPointerDown(e: PointerEvent): void {
  // preventDefault suppresses the native image-drag / text-selection gesture
  // so it cannot hijack the pointer sequence (user-select + touch-action on
  // the box are the second layer of defense).
  e.preventDefault()
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  updateFromPointer(e)
}
function onPointerMove(e: PointerEvent): void {
  if (dragging.value) updateFromPointer(e)
}
function onPointerUp(): void {
  dragging.value = false
}
function updateFromPointer(e: PointerEvent): void {
  const box = compareBox.value
  if (!box) return
  const rect = box.getBoundingClientRect()
  if (rect.width <= 0) return
  const pct = ((e.clientX - rect.left) / rect.width) * 100
  slider.value = Math.min(100, Math.max(0, pct))
}
function onKeydown(e: KeyboardEvent): void {
  // The listener lives for the app's lifetime (the component never unmounts),
  // so stay inert while the overlay is closed — never swallow Escapes meant
  // for other layers (lightbox, dialogs, confirm).
  if (store.phase !== 'busy' && store.phase !== 'compare') return
  if (e.key === 'Escape') {
    e.preventDefault()
    // stopImmediatePropagation, not stopPropagation: same-target listeners
    // are NOT stopped by stopPropagation, and the lightbox's Escape handler
    // (always registered after this one) would otherwise close the lightbox
    // underneath the overlay on the same keypress.
    e.stopImmediatePropagation()
    store.close()
  } else if (store.phase === 'compare' && e.key === 'ArrowLeft') {
    slider.value = Math.max(0, slider.value - 2)
  } else if (store.phase === 'compare' && e.key === 'ArrowRight') {
    slider.value = Math.min(100, slider.value + 2)
  }
}

function loadImages(): void {
  beforeSrc.value = ''
  afterSrc.value = ''
  beforeFailed.value = false
  afterFailed.value = false
  // every compare starts from the midpoint (the ref persists across compares)
  slider.value = 50
  if (store.sourcePath) {
    window.api
      .imageFromPath(store.sourcePath)
      .then((d) => (beforeSrc.value = d))
      .catch(() => (beforeFailed.value = true))
  }
  if (store.resultPath) {
    window.api
      .imageFromPath(store.resultPath)
      .then((d) => (afterSrc.value = d))
      .catch(() => (afterFailed.value = true))
  }
}

watch(
  () => store.phase,
  (phase) => {
    if (phase === 'compare') loadImages()
  },
  { immediate: true }
)

onMounted(() => {
  // Capture-phase Escape registered BEFORE the lightbox's listener — launching
  // from the lightbox must not let the lightbox's Escape close the wrong
  // layer. Removed on unmount.
  window.addEventListener('keydown', onKeydown, true)
  document.body.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="store.phase === 'busy' || store.phase === 'compare'" class="overlay">
      <!-- busy phase -->
      <div v-if="store.phase === 'busy'" class="busy-wrap">
        <div class="spinner" aria-hidden="true"></div>
        <div class="busy-hint">Upscaling…</div>
      </div>

      <!-- compare phase -->
      <div v-else class="compare-wrap">
        <div
          ref="compareBox"
          class="compare-box"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <!-- before (bottom layer) -->
          <img v-if="beforeSrc && !beforeFailed" :src="beforeSrc" class="compare-img" alt="Before" />
          <div v-else class="compare-img compare-missing mono">image unavailable</div>
          <!-- after (top layer): a FULL-SIZE layer clipped to the divider's
               right side via clip-path — the image itself never resizes or
               re-fits, so it stays pixel-aligned with the before layer
               underneath (a shrinking width-clip would re-fit the image
               inside the clip and break the alignment). Before shows left of
               the divider, After right — matching the labels. -->
          <div class="after-layer" :style="{ clipPath: `inset(0 0 0 ${slider}%)` }">
            <img v-if="afterSrc && !afterFailed" :src="afterSrc" class="compare-img" alt="After" />
            <div v-else class="compare-img compare-missing mono">image unavailable</div>
          </div>
          <div class="divider" :style="{ left: slider + '%' }"></div>
          <div class="label before-label">Before</div>
          <div class="label after-label">After</div>
        </div>
        <div class="compare-actions">
          <button class="btn" @click="store.close()">Close</button>
          <button class="btn primary" :disabled="!afterSrc" @click="saveImageAs(store.resultPath!)">
            Save as…
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 2600;
  background: rgba(10, 11, 15, 0.96);
  display: flex;
  align-items: center;
  justify-content: center;
}
.busy-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.spinner {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 4px solid var(--border);
  border-top-color: var(--accent);
  animation: upscale-spin 0.9s linear infinite;
}
@keyframes upscale-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}
.busy-hint {
  color: var(--text-faint);
  font-size: 14px;
}
.compare-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: min(1100px, 94vw);
  height: min(760px, 92vh);
}
.compare-box {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  touch-action: none;
  cursor: ew-resize;
  user-select: none;
}
.compare-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
}
.after-layer {
  /* full-size overlay layer; the inline clip-path cuts everything LEFT of
     the divider so the AFTER image shows only on the divider's right side —
     same display box as the before layer, so differing pixel dimensions
     align and the clip is the only difference */
  position: absolute;
  inset: 0;
}
.compare-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}
.divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  transform: translateX(-1px);
  pointer-events: none;
}
.divider::after {
  /* grab-handle knob: makes the draggable divider discoverable */
  content: '‹ ›';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid var(--accent);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  letter-spacing: 2px;
}
.label {
  position: absolute;
  top: 10px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  pointer-events: none;
}
.before-label {
  left: 10px;
}
.after-label {
  right: 10px;
}
.compare-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.btn {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  cursor: pointer;
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
