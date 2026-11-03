<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
/**
 * Paint dialog — the composer's paint-button target.
 *
 * Shows the background image with a transparent paint canvas on top; the user
 * paints strokes (black / white / red swatches) and Save exports a MERGED
 * image: the background with the strokes composited on top, KEEPING the
 * painted colors (the opposite of the inpaint mask's normalization, where the
 * brush color is discarded). The merged PNG is used by the panel as either
 * --init-img or the first --ref-image depending on where the background came
 * from — routing is decided by the panel at save time, not here.
 *
 * Strokes are recorded in NATURAL-image coordinates (display→natural scale
 * mapping) and the composite is built at the background's natural size, so
 * the exported image matches the background pixel-for-pixel no matter how the
 * dialog scales the preview. The panel owns the file lifecycle: this dialog
 * calls masksSave once per Save and emits the result up; Clear wipes the
 * canvas strokes and emits — the panel drops its sticky paint state (and the
 * saved file) on its side.
 *
 * Re-open semantics: the panel passes the SAVED merged image as the
 * background (the strokes are baked into it), so reopening continues painting
 * on top of the previous result. There is no Override Resolution checkbox —
 * the merged image is consumed like any attached image and the session's
 * resolution dropdown governs the output size.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from '../toast'

const props = defineProps<{
  /** background image as a data URL (loaded by the panel via imageFromPath) */
  background: string
}>()

const emit = defineEmits<{
  save: [
    payload: {
      /** merged PNG under data/tmp/masks (returned by masksSave) */
      paintPath: string
      /** the background's natural size — informational (composer chip) */
      width: number
      height: number
    }
  ]
  clear: []
  close: []
}>()

const imgEl = ref<HTMLImageElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const nat = ref({ w: 0, h: 0 })
const COLORS = ['black', 'white', 'red'] as const
const color = ref<(typeof COLORS)[number]>('black')
const size = ref(24)
const hasPaint = ref(false)
const saving = ref(false)

const BRUSH_SWATCH: Record<(typeof COLORS)[number], string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#e5484d'
}

function onImgLoad(): void {
  const img = imgEl.value
  const canvas = canvasEl.value
  if (!img || !canvas) return
  nat.value = { w: img.naturalWidth, h: img.naturalHeight }
  canvas.width = nat.value.w
  canvas.height = nat.value.h
}

// ---------- painting ----------
let drawing = false
let last: { x: number; y: number } | null = null

function toNatural(e: PointerEvent): { x: number; y: number } {
  const canvas = canvasEl.value!
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height
  }
}

function stroke(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const ctx = canvasEl.value?.getContext('2d')
  if (!ctx) return
  ctx.strokeStyle = BRUSH_SWATCH[color.value]
  ctx.lineWidth = size.value
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  // a bare click (zero-length segment) renders as a round dot via the tiny
  // offset — zero-length lines are skipped by some browsers
  ctx.lineTo(b.x === a.x && b.y === a.y ? b.x + 0.01 : b.x, b.y)
  ctx.stroke()
  hasPaint.value = true
}

function onPointerDown(e: PointerEvent): void {
  const canvas = canvasEl.value
  if (!canvas) return
  canvas.setPointerCapture(e.pointerId)
  drawing = true
  const p = toNatural(e)
  last = p
  stroke(p, p)
}

function onPointerMove(e: PointerEvent): void {
  if (!drawing || !canvasEl.value) return
  const p = toNatural(e)
  if (last) stroke(last, p)
  last = p
}

function onPointerUp(): void {
  drawing = false
  last = null
}

// ---------- actions ----------
async function save(): Promise<void> {
  const img = imgEl.value
  const canvas = canvasEl.value
  if (!img || !canvas || !hasPaint.value || saving.value) return
  saving.value = true
  try {
    // Merge: the background at its natural size with the painted strokes on
    // top — painted pixels keep their painted RGB at full opacity, unpainted
    // areas stay background. Unlike the inpaint mask there is NO
    // normalization pass: the brush colors are the point here.
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    const octx = out.getContext('2d')
    if (!octx) throw new Error('Canvas unavailable')
    octx.drawImage(img, 0, 0, nat.value.w, nat.value.h)
    octx.drawImage(canvas, 0, 0)
    const mergedPng = out.toDataURL('image/png')
    const res = await window.api.masksSave({ kind: 'paint', maskPng: mergedPng })
    emit('save', {
      paintPath: res.maskPath,
      width: nat.value.w,
      height: nat.value.h
    })
  } catch (err) {
    // A failed save toasts and keeps the dialog open — the painted strokes
    // are still on the canvas and can be saved again.
    toast(`Failed to save painted image: ${(err as Error).message}`, 'error')
  } finally {
    saving.value = false
  }
}

function clear(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  hasPaint.value = false
  // The panel owns all file/state lifecycle — this dialog only wipes the
  // strokes and lets the panel drop its sticky paint state.
  emit('clear')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Paint">
      <header class="dialog-header">
        <h2>Paint</h2>
        <span class="muted faint">paint directly onto the image</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <div class="paint-stage">
          <img
            ref="imgEl"
            :src="props.background"
            alt="Paint background"
            @load="onImgLoad"
          />
          <canvas
            ref="canvasEl"
            class="paint-canvas"
            @pointerdown.prevent="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          ></canvas>
        </div>

        <div class="tool-row">
          <span class="tool-label">Brush</span>
          <button
            v-for="c in COLORS"
            :key="c"
            class="swatch"
            :class="{ active: color === c }"
            :style="{ background: BRUSH_SWATCH[c] }"
            :title="c"
            :aria-label="`${c} brush`"
            @click="color = c"
          ></button>
          <span class="tool-label">Size</span>
          <input v-model.number="size" type="range" min="4" max="128" step="1" class="size-slider" />
          <span class="mono faint">{{ size }}px</span>
        </div>
      </div>

      <footer class="dialog-footer">
        <span class="faint hint">The painted image is merged with the background on Save.</span>
        <button @click="clear()">Clear</button>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="!hasPaint || saving" @click="save()">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
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
  width: min(760px, 94vw);
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
  overflow: auto;
}
.paint-stage {
  position: relative;
  align-self: center;
  max-width: 100%;
  line-height: 0;
}
.paint-stage img {
  max-width: 100%;
  max-height: 56vh;
  display: block;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.paint-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}
.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tool-label {
  font-size: 12px;
  color: var(--text-dim);
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--border);
  cursor: pointer;
  padding: 0;
}
.swatch.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.size-slider {
  width: 160px;
}
.dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.hint {
  font-size: 12px;
  margin-right: auto;
}
</style>
