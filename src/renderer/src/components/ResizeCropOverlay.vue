<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import type { ResolutionEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useResizeStore } from '../stores/resize'
import { baseName } from '../search'
import { toast } from '../toast'

/**
 * Full-screen non-destructive image resize / crop editor
 * (plans/image-resize-crop.md). Driven by the `resize` Pinia store; mounted
 * once in App.vue. The ORIGINAL picked file is never modified — Save produces
 * a NEW PNG under data/media/resize/ via `resize:save` and the store records it.
 */

const CUSTOM_MIN = 16
const CUSTOM_MAX = 4096

const appStore = useAppStore()
const store = useResizeStore()

const imgEl = ref<HTMLImageElement | null>(null)
let cropper: Cropper | null = null
// Reactive mirror of `cropper !== null` — the cropper instance itself is a
// plain module-scope object (non-reactive), so the Save button's computed
// needs this flag to re-evaluate once the instance is created.
const ready = ref(false)

/** Data URL of the current image (loaded via app:imageFromPath). */
const src = ref('')
/** Natural size of the loaded image (for the header chip and custom seeding). */
const natural = ref({ w: 0, h: 0 })

// ---------- size mode ----------
// 'preset'   — a resolution preset locks the crop aspect AND sets the output size
// 'custom'   — free crop + free width/height override
// 'original' — crop only, output at the cropped region's native resolution
// 'resize'   — scale the entire image to W×H (crop box disabled), optional aspect lock
const mode = ref<'preset' | 'custom' | 'original' | 'resize'>('original')
const presetName = ref('')
const width = ref(0)
const height = ref(0)

// Aspect-lock state (resize mode only):
const lockAspect = ref(true)

// Source aspect ratio (w/h of the natural image):
const sourceAspect = computed(() =>
  natural.value.w > 0 && natural.value.h > 0 ? natural.value.w / natural.value.h : null
)

// Live preview data URL (resize mode only):
const previewSrc = ref('')

const presets = computed<ResolutionEntry[]>(() =>
  store.diffusionType ? appStore.resolutionsFor(store.diffusionType) : []
)
const current = computed(() => store.queue[store.index] ?? null)
const total = computed(() => store.queue.length)
const position = computed(() => store.index + 1)
const multi = computed(() => total.value > 1)
const saveLabel = computed(() => (multi.value ? 'Save & Next' : 'Save'))
const canSave = computed(() => src.value !== '' && ready.value)

/** Resolve when the <img> has decoded its current src (or failed). */
function waitForImage(img: HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) {
      resolve()
      return
    }
    const done = (): void => {
      img.removeEventListener('load', done)
      img.removeEventListener('error', done)
      resolve()
    }
    img.addEventListener('load', done)
    img.addEventListener('error', done)
  })
}

/** Tear down + rebuild the cropper instance for the current queue item. */
watch(
  () => (store.open ? (current.value?.path ?? null) : null),
  async (path) => {
    cropper?.destroy()
    cropper = null
    ready.value = false
    src.value = ''
    natural.value = { w: 0, h: 0 }
    if (!path) return
    src.value = await window.api.imageFromPath(path)
    await nextTick()
    if (!imgEl.value || !src.value) return
    await waitForImage(imgEl.value)
    if (!store.open || current.value?.path !== path) return // queue moved on / closed
    natural.value = { w: imgEl.value.naturalWidth, h: imgEl.value.naturalHeight }
    // Reset the per-image UI state — each image starts in crop-only mode.
    mode.value = 'original'
    presetName.value = ''
    width.value = natural.value.w
    height.value = natural.value.h
    lockAspect.value = true
    previewSrc.value = ''
    cropper = new Cropper(imgEl.value, {
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      crop: onCropEvent
    })
    ready.value = true
  },
  { immediate: true }
)

// Aspect lock follows the mode: presets lock to their ratio, everything else crops freely.
watch(mode, (m) => {
  if (!cropper) return
  if (m === 'resize') {
    // The crop box serves as the resize target — keep it enabled.
    // Aspect ratio is set by pickResize() or the lockAspect watcher.
    previewSrc.value = ''
    return
  }
  cropper.enable()
  const p = presets.value.find((x) => x.name === presetName.value)
  if (m === 'preset' && p) cropper.setAspectRatio(p.width / p.height)
  else cropper.setAspectRatio(NaN)
})

// In resize mode, the aspect-lock checkbox controls the crop box's aspect ratio.
watch(lockAspect, (locked) => {
  if (mode.value !== 'resize') return
  if (locked && sourceAspect.value !== null) cropper?.setAspectRatio(sourceAspect.value)
  else cropper?.setAspectRatio(NaN)
})

function pickPreset(p: ResolutionEntry): void {
  if (mode.value === 'resize') {
    // In resize mode: set W/H to the preset dimensions, stay in resize mode.
    presetName.value = p.name
    width.value = p.width
    height.value = p.height
    cropper?.setAspectRatio(p.width / p.height)
    return
  }
  mode.value = 'preset'
  presetName.value = p.name
  width.value = p.width
  height.value = p.height
  cropper?.setAspectRatio(p.width / p.height)
}

function pickCustom(): void {
  mode.value = 'custom'
  presetName.value = ''
  // Seed the inputs from the current crop box so the numbers start meaningful.
  const data = cropper?.getData()
  width.value = Math.max(CUSTOM_MIN, Math.round(data?.width ?? natural.value.w))
  height.value = Math.max(CUSTOM_MIN, Math.round(data?.height ?? natural.value.h))
  cropper?.setAspectRatio(NaN)
}

function pickOriginal(): void {
  mode.value = 'original'
  presetName.value = ''
  cropper?.setAspectRatio(NaN)
}

function pickResize(): void {
  mode.value = 'resize'
  presetName.value = ''
  lockAspect.value = true
  // Seed W/H from the natural image size:
  width.value = natural.value.w
  height.value = natural.value.h
  // The crop box serves as the resize target — keep it enabled.
  // Lock the aspect ratio to the source image's ratio:
  if (sourceAspect.value !== null) cropper?.setAspectRatio(sourceAspect.value)
  // Reset the crop box to the full image:
  cropper?.reset()
  // Clear any stale preview:
  previewSrc.value = ''
}

/**
 * Scale the entire source image to w×h on a fresh canvas.
 * Independent of the cropper's crop box — used by both the live preview
 * and saveCurrent() in 'resize' mode.
 */
function resizeCanvas(w: number, h: number): HTMLCanvasElement | null {
  const img = imgEl.value
  if (!img || img.naturalWidth === 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  return canvas
}

/**
 * Read the raw typed value from the DOM event target (not the reactive model,
 * which is stale mid-keystroke). Only the linked box is clamped — the box the
 * user is typing into is written verbatim so multi-digit values accumulate.
 *
 * NOTE: we deliberately do NOT call syncCropBoxFromDims() here. In resize mode
 * the W/H inputs are the single source of truth; pushing values into the
 * cropper makes it adjust/clamp the box, then its async `crop` event (fired via
 * requestAnimationFrame) reads the box back and overwrites the user's number.
 * The cropper is only a visual aid — dragging the box still updates the inputs
 * via onCropEvent().
 */
function onResizeWidthInput(e: Event): void {
  const raw = parseInt((e.target as HTMLInputElement).value, 10)
  width.value = Number.isNaN(raw) ? 0 : raw
  if (lockAspect.value && sourceAspect.value !== null) {
    height.value = clampResizeDim(Math.round(raw / sourceAspect.value))
  }
}

function onResizeHeightInput(e: Event): void {
  const raw = parseInt((e.target as HTMLInputElement).value, 10)
  height.value = Number.isNaN(raw) ? 0 : raw
  if (lockAspect.value && sourceAspect.value !== null) {
    width.value = clampResizeDim(Math.round(raw * sourceAspect.value))
  }
}

function clampResizeDim(v: number): number {
  if (!Number.isFinite(v) || v < CUSTOM_MIN) return CUSTOM_MIN
  return Math.min(CUSTOM_MAX, Math.round(v))
}

/**
 * Cropperjs `crop` event handler — in resize mode, maps the crop box
 * dimensions to W/H values (in natural image coordinates). The crop box
 * IS the resize target: dragging it sets the output dimensions.
 */
function onCropEvent(): void {
  if ((mode.value !== 'resize' && mode.value !== 'custom') || !cropper) return
  const cropBox = cropper.getCropBoxData()
  const canvasData = cropper.getCanvasData()
  if (!cropBox || !canvasData || canvasData.width === 0) return
  const w = Math.round((cropBox.width / canvasData.width) * natural.value.w)
  const h = Math.round((cropBox.height / canvasData.height) * natural.value.h)
  width.value = clampResizeDim(w)
  height.value = clampResizeDim(h)
}

// ---------- debounced live preview (resize mode) ----------
let previewTimer: ReturnType<typeof setTimeout> | null = null

watch([width, height], () => {
  if (mode.value !== 'resize') return
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    const w = clampResizeDim(width.value)
    const h = clampResizeDim(height.value)
    const canvas = resizeCanvas(w, h)
    previewSrc.value = canvas ? canvas.toDataURL('image/png') : ''
  }, 200)
})

// ---------- cropperjs tool buttons ----------
function zoom(delta: number): void {
  cropper?.zoom(delta)
}
function rotate(deg: number): void {
  cropper?.rotate(deg)
}
function resetCrop(): void {
  cropper?.reset()
}

// ---------- middle-click panning ----------
// Middle-drag repositions the image (cropperjs `move()`) WITHOUT touching the
// left-drag crop behavior. The `.middle.prevent` template modifier keeps the
// browser's middle-click autoscroll out of the way.
const panning = ref(false)
let panLast = { x: 0, y: 0 }

function startPan(e: MouseEvent): void {
  if (!cropper) return
  panLast = { x: e.clientX, y: e.clientY }
  panning.value = true
  window.addEventListener('mousemove', onPanMove)
  window.addEventListener('mouseup', endPan)
}

function onPanMove(e: MouseEvent): void {
  if (!panning.value || !cropper) return
  cropper.move(e.clientX - panLast.x, e.clientY - panLast.y)
  panLast = { x: e.clientX, y: e.clientY }
}

function endPan(): void {
  panning.value = false
  window.removeEventListener('mousemove', onPanMove)
  window.removeEventListener('mouseup', endPan)
}

/**
 * Produce the processed PNG for the current image and persist it as a NEW
 * file under data/tmp/resize. Resolves the written path, or null when the
 * save was aborted (invalid input / crop / IPC failure — already toasted).
 */
async function saveCurrent(): Promise<string | null> {
  if (!src.value) return null
  let canvas: HTMLCanvasElement | null
  if (mode.value === 'resize') {
    const w = Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(width.value)))
    const h = Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(height.value)))
    canvas = resizeCanvas(w, h)
  } else {
    if (!cropper) return null
    const options =
      mode.value === 'original'
        ? undefined
        : {
            width: Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(width.value))),
            height: Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(height.value)))
          }
    if (options && (!options.width || !options.height)) {
      toast('Enter a valid width and height', 'error')
      return null
    }
    canvas = cropper.getCroppedCanvas(options)
  }
  if (!canvas) {
    toast('Processing failed — adjust and try again', 'error')
    return null
  }
  try {
    const res = await window.api.resizeSave({ png: canvas.toDataURL('image/png') })
    return res.path
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed to save the resized image', 'error')
    return null
  }
}

/** Save the current image and advance the queue (the store handles advancing). */
async function save(): Promise<void> {
  const path = await saveCurrent()
  if (path) store.commitCurrent(path)
}

/** Pass the current image through unmodified and advance the queue. */
function skip(): void {
  store.skipCurrent()
}

/** Abort the whole add — nothing is attached. */
function cancel(): void {
  store.cancelAll()
}

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
  cropper?.destroy()
  cropper = null
  ready.value = false
  window.removeEventListener('mousemove', onPanMove)
  window.removeEventListener('mouseup', endPan)
})
</script>

<template>
  <div v-if="store.open" class="rz-overlay">
    <div class="rz-head">
      <span class="rz-title">Resize / Crop</span>
      <span class="rz-file" :title="current?.path">{{ baseName(current?.path ?? '') }}</span>
      <span v-if="multi" class="rz-pos">{{ position }} / {{ total }}</span>
      <span class="rz-hint">The original file is never modified — edits are saved as a copy</span>
    </div>
    <div class="rz-body">
      <div class="rz-canvas" :class="{ panning }" @mousedown.middle.prevent="startPan($event)">
        <img v-if="src" ref="imgEl" :src="src" alt="" class="rz-img" />
        <div v-else class="rz-error">Could not load this image — use Skip to add it as-is.</div>
      </div>
      <div class="rz-side">
        <div class="rz-section">Size</div>
        <div class="rz-modes">
          <button
            class="rz-mode"
            :class="{ active: mode === 'original' }"
            type="button"
            @click="pickOriginal()"
          >
            Crop only
          </button>
          <button
            class="rz-mode"
            :class="{ active: mode === 'custom' }"
            type="button"
            @click="pickCustom()"
          >
            Custom size
          </button>
          <button
            class="rz-mode"
            :class="{ active: mode === 'resize' }"
            type="button"
            @click="pickResize()"
          >
            Resize
          </button>
        </div>
        <div v-if="mode === 'custom'" class="rz-dims">
          <label class="rz-field">
            <span>Width</span>
            <input v-model.number="width" type="number" :min="16" :max="4096" />
          </label>
          <label class="rz-field">
            <span>Height</span>
            <input v-model.number="height" type="number" :min="16" :max="4096" />
          </label>
        </div>
        <div v-if="mode === 'resize'">
          <div class="rz-dims">
            <label class="rz-field">
              <span>Width</span>
              <input
                :value="width"
                type="number"
                :min="16"
                :max="4096"
                @input="onResizeWidthInput($event)"
              />
            </label>
            <label class="rz-field">
              <span>Height</span>
              <input
                :value="height"
                type="number"
                :min="16"
                :max="4096"
                @input="onResizeHeightInput($event)"
              />
            </label>
          </div>
          <label class="rz-lock">
            <input v-model="lockAspect" type="checkbox" />
            <span>Lock aspect ratio</span>
          </label>
          <div class="rz-hint-text">Source: {{ natural.w }}×{{ natural.h }}</div>
          <div v-if="previewSrc" class="rz-preview">
            <img :src="previewSrc" alt="Preview" />
          </div>
        </div>
        <template v-if="presets.length">
          <div class="rz-section">Presets — {{ store.diffusionType }}</div>
          <div class="rz-presets">
            <button
              v-for="p in presets"
              :key="p.name"
              class="rz-preset"
              :class="{ active: (mode === 'preset' || mode === 'resize') && presetName === p.name }"
              type="button"
              @click="pickPreset(p)"
            >
              <span class="rz-preset-name">{{ p.name }}</span>
              <span class="rz-preset-dims">{{ p.width }}×{{ p.height }}</span>
            </button>
          </div>
        </template>
        <div v-else class="rz-empty">No resolution presets for this model.</div>
        <div class="rz-section">Tools</div>
        <div class="rz-tools">
          <button type="button" title="Zoom in" @click="zoom(0.1)">+</button>
          <button type="button" title="Zoom out" @click="zoom(-0.1)">−</button>
          <button type="button" title="Rotate left" @click="rotate(-90)">↺</button>
          <button type="button" title="Rotate right" @click="rotate(90)">↻</button>
          <button type="button" title="Reset crop" @click="resetCrop()">Reset</button>
        </div>
      </div>
    </div>
    <div class="rz-foot">
      <button class="rz-btn" type="button" @click="cancel()">Cancel</button>
      <span class="rz-spacer"></span>
      <button class="rz-btn" type="button" @click="skip()">
        Skip{{ multi ? ' (add as-is)' : '' }}
      </button>
      <button class="rz-btn primary" type="button" :disabled="!canSave" @click="save()">
        {{ saveLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.rz-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.rz-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.rz-title {
  font-weight: 600;
  color: var(--text);
}
.rz-file {
  color: var(--text-dim);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rz-pos {
  color: var(--accent);
  font-weight: 600;
}
.rz-hint {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 12px;
}
.rz-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.rz-canvas {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
}
.rz-canvas.panning {
  cursor: grabbing;
}
.rz-img {
  display: block;
  max-width: 100%;
}
.rz-error {
  color: var(--danger);
  padding: 24px;
}
.rz-side {
  width: 300px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 14px;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rz-section {
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.rz-modes {
  display: flex;
  gap: 8px;
}
.rz-mode {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  cursor: pointer;
}
.rz-mode.active {
  border-color: var(--accent);
  color: var(--text);
  background: var(--accent-soft);
}
.rz-dims {
  display: flex;
  gap: 8px;
}
.rz-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-dim);
  font-size: 12px;
}
.rz-field input {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 6px 8px;
}
.rz-presets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rz-preset {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  cursor: pointer;
  text-align: left;
}
.rz-preset.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.rz-preset.active .rz-preset-name {
  color: var(--text);
}
.rz-preset-name {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rz-preset-dims {
  color: var(--text-faint);
  font-size: 12px;
  flex-shrink: 0;
}
.rz-empty {
  color: var(--text-faint);
  font-size: 12px;
}
.rz-tools {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.rz-tools button {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  cursor: pointer;
}
.rz-tools button:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.rz-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
.rz-spacer {
  flex: 1;
}
.rz-btn {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  cursor: pointer;
}
.rz-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.rz-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.rz-btn.primary:hover {
  background: var(--accent-hover);
}
.rz-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rz-lock {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.rz-lock input {
  accent-color: var(--accent);
}
.rz-hint-text {
  color: var(--text-faint);
  font-size: 12px;
}
.rz-preview {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}
.rz-preview img {
  max-height: 120px;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
}
</style>
