<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
/**
 * Inpaint dialog — the composer's brush-button target.
 *
 * Shows the background image with a transparent mask canvas on top; the user
 * paints strokes (black / white / red swatches are a painting affordance
 * only) and Save exports the mask NORMALIZED to opaque-white-on-transparent
 * regardless of the brush color used — painted pixels become
 * rgba(255,255,255,1), unpainted stay rgba(0,0,0,0) — so the mask semantics
 * are deterministic whether sd-cli reads luminance or alpha.
 *
 * Strokes are recorded in NATURAL-image coordinates (display→natural scale
 * mapping) so the exported mask matches the background pixel-for-pixel no
 * matter how the dialog scales the preview. The panel owns the file
 * lifecycle: this dialog calls masksSave once per Save and emits the result
 * up; Clear only wipes the canvas strokes and emits — masksClear is the
 * panel's job.
 *
 * Re-open semantics: the panel passes the SAVED mask back as `restoredMask`
 * (loaded via imageFromPath — no data URL is kept in state) and it is drawn
 * onto the canvas as the initial paint layer, which also enables Save
 * without new strokes.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from '../toast'

/** Dimension snap divisor — the bundled runtime's minimum dimension
 *  alignment is model-family-dependent (some require /64); adjust here after
 *  verifying against the runtime (plans/inpainting-outpainting.md §Design). */
const SNAP = 8

const props = defineProps<{
  /** background image as a data URL (loaded by the panel via imageFromPath) */
  background: string
  /** saved mask as a data URL when a mask is already active ('' when not) */
  restoredMask?: string
  /** initial Override Resolution checkbox state (the sticky mask state) */
  overrideResolution: boolean
}>()

const emit = defineEmits<{
  save: [
    payload: {
      maskPath: string
      /** background's /8-snapped natural size — the request resolution when
       *  Override Resolution is off */
      width: number
      height: number
      overrideResolution: boolean
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
const override = ref(props.overrideResolution)

const BRUSH_SWATCH: Record<(typeof COLORS)[number], string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#e5484d'
}

function snap8(w: number, h: number): { width: number; height: number } {
  return {
    width: Math.max(SNAP, Math.round(w / SNAP) * SNAP),
    height: Math.max(SNAP, Math.round(h / SNAP) * SNAP)
  }
}

function onImgLoad(): void {
  const img = imgEl.value
  const canvas = canvasEl.value
  if (!img || !canvas) return
  nat.value = { w: img.naturalWidth, h: img.naturalHeight }
  canvas.width = nat.value.w
  canvas.height = nat.value.h
  if (props.restoredMask) {
    const m = new Image()
    m.onload = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(m, 0, 0, nat.value.w, nat.value.h)
      hasPaint.value = true
    }
    m.src = props.restoredMask
  }
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
  const canvas = canvasEl.value
  if (!canvas || !hasPaint.value || saving.value) return
  saving.value = true
  try {
    // Normalize to opaque-white-on-transparent: painted → rgba(255,255,255,1),
    // unpainted → rgba(0,0,0,0). Brush colors never reach the exported file.
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    const octx = out.getContext('2d')
    if (!octx) throw new Error('Canvas unavailable')
    octx.drawImage(canvas, 0, 0)
    const data = octx.getImageData(0, 0, out.width, out.height)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 0) {
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
        px[i + 3] = 255
      } else {
        px[i] = 0
        px[i + 1] = 0
        px[i + 2] = 0
        px[i + 3] = 0
      }
    }
    octx.putImageData(data, 0, 0)
    const maskPng = out.toDataURL('image/png')
    const res = await window.api.masksSave({ kind: 'inpaint', maskPng })
    const snapped = snap8(nat.value.w, nat.value.h)
    emit('save', {
      maskPath: res.maskPath,
      width: snapped.width,
      height: snapped.height,
      overrideResolution: override.value
    })
  } catch (err) {
    // A failed save toasts and keeps the dialog open — the painted strokes
    // are still on the canvas and can be saved again.
    toast(`Failed to save mask: ${(err as Error).message}`, 'error')
  } finally {
    saving.value = false
  }
}

function clear(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  hasPaint.value = false
  // The panel owns all file deletion — this dialog only wipes the strokes.
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
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Inpaint">
      <header class="dialog-header">
        <h2>Inpaint</h2>
        <span class="muted faint">paint the area to regenerate</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <div class="paint-stage">
          <img
            ref="imgEl"
            :src="background"
            alt="Mask background"
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
        <label class="chk override" title="Run at the session's resolution instead of the image's own size">
          <input v-model="override" type="checkbox" />
          Override Resolution
        </label>
        <span class="faint hint">Adjust strength to 1.0 in Sampling for better results.</span>
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
.override {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  white-space: nowrap;
}
.hint {
  font-size: 12px;
  margin-right: auto;
}
</style>
