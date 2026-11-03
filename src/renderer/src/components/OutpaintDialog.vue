<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
/**
 * Outpaint dialog — the composer's expand-frame button target.
 *
 * The background image is shown centered; four edge sliders (left / right /
 * top / bottom, 0–512 px, step 8) grow the canvas by that many pixels per
 * edge, previewed as a white border. Save composes TWO images at the snapped
 * expanded size and sends both to masksSave:
 *   1. the padded init image — the original centered, border solid gray
 *      #808080 (the border is fully regenerated anyway);
 *   2. the mask — border opaque white, center transparent.
 *
 * Composition ALWAYS happens in natural+margin pixel space (never in preview
 * scale). When the natural size is not /8-aligned it is snapped FIRST, then
 * the step-8 margins are added — the sub-8 remainder is absorbed by the
 * border, so image + margins + border always equal the composed canvas.
 *
 * The panel owns the file lifecycle (masksClear on save-over/clear); this
 * dialog only calls masksSave once per Save and emits the result up.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from '../toast'

/** Dimension snap divisor — see InpaintDialog (verify against the runtime). */
const SNAP = 8
const EDGE_MAX = 512

export interface OutpaintMargins {
  left: number
  right: number
  top: number
  bottom: number
}

const props = defineProps<{
  /** original background image as a data URL (loaded by the panel) */
  background: string
  /** saved margins when a mask is already active (sliders restore from them) */
  restoredMargins?: OutpaintMargins | null
  /** initial Override Resolution checkbox state (the sticky mask state) */
  overrideResolution: boolean
}>()

const emit = defineEmits<{
  save: [
    payload: {
      maskPath: string
      initPath: string
      /** snapped expanded size — the request resolution when Override
       *  Resolution is off */
      width: number
      height: number
      margins: OutpaintMargins
      overrideResolution: boolean
    }
  ]
  clear: []
  close: []
}>()

const imgEl = ref<HTMLImageElement | null>(null)
const nat = ref({ w: 0, h: 0 })
const scale = ref(1)
const left = ref(0)
const right = ref(0)
const top = ref(0)
const bottom = ref(0)
const saving = ref(false)
const override = ref(props.overrideResolution)

/** Snapped natural size — snapped FIRST, margins added after. */
const snapped = computed(() => ({
  w: Math.max(SNAP, Math.round(nat.value.w / SNAP) * SNAP),
  h: Math.max(SNAP, Math.round(nat.value.h / SNAP) * SNAP)
}))
const expanded = computed(() => ({
  w: snapped.value.w + left.value + right.value,
  h: snapped.value.h + top.value + bottom.value
}))
const hasExpand = computed(
  () => left.value > 0 || right.value > 0 || top.value > 0 || bottom.value > 0
)

const stageStyle = computed(() => ({
  width: `${Math.round(expanded.value.w * scale.value)}px`,
  height: `${Math.round(expanded.value.h * scale.value)}px`
}))
const imgStyle = computed(() => ({
  left: `${Math.round(((expanded.value.w - nat.value.w) / 2) * scale.value)}px`,
  top: `${Math.round(((expanded.value.h - nat.value.h) / 2) * scale.value)}px`,
  width: `${Math.round(nat.value.w * scale.value)}px`,
  height: `${Math.round(nat.value.h * scale.value)}px`
}))

function onImgLoad(): void {
  const img = imgEl.value
  if (!img) return
  nat.value = { w: img.naturalWidth, h: img.naturalHeight }
  // Fixed preview scale chosen from the natural size; the stage grows with
  // the sliders and scrolls inside its container instead of rescaling.
  scale.value = Math.min(1, 460 / nat.value.w, 340 / nat.value.h)
}

async function save(): Promise<void> {
  const img = imgEl.value
  if (!img || !hasExpand.value || saving.value) return
  saving.value = true
  try {
    const W = expanded.value.w
    const H = expanded.value.h
    const imgX = (W - nat.value.w) / 2
    const imgY = (H - nat.value.h) / 2

    // 1. padded init image — gray #808080 border, original centered
    const init = document.createElement('canvas')
    init.width = W
    init.height = H
    const ictx = init.getContext('2d')
    if (!ictx) throw new Error('Canvas unavailable')
    ictx.fillStyle = '#808080'
    ictx.fillRect(0, 0, W, H)
    ictx.drawImage(img, imgX, imgY, nat.value.w, nat.value.h)

    // 2. mask — border opaque white (repaint), center transparent (keep)
    const mask = document.createElement('canvas')
    mask.width = W
    mask.height = H
    const mctx = mask.getContext('2d')
    if (!mctx) throw new Error('Canvas unavailable')
    mctx.fillStyle = '#ffffff'
    mctx.fillRect(0, 0, W, H)
    mctx.clearRect(imgX, imgY, nat.value.w, nat.value.h)

    const res = await window.api.masksSave({
      kind: 'outpaint',
      maskPng: mask.toDataURL('image/png'),
      initPng: init.toDataURL('image/png')
    })
    const margins: OutpaintMargins = {
      left: left.value,
      right: right.value,
      top: top.value,
      bottom: bottom.value
    }
    emit('save', {
      maskPath: res.maskPath,
      initPath: res.initPath!,
      width: W,
      height: H,
      margins,
      overrideResolution: override.value
    })
  } catch (err) {
    toast(`Failed to save outpaint mask: ${(err as Error).message}`, 'error')
  } finally {
    saving.value = false
  }
}

function clear(): void {
  left.value = 0
  right.value = 0
  top.value = 0
  bottom.value = 0
  // The panel owns all file deletion — this dialog only resets the sliders.
  emit('clear')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  if (props.restoredMargins) {
    left.value = props.restoredMargins.left
    right.value = props.restoredMargins.right
    top.value = props.restoredMargins.top
    bottom.value = props.restoredMargins.bottom
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Outpaint">
      <header class="dialog-header">
        <h2>Outpaint</h2>
        <span class="muted faint">expand the canvas on any edge</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <div class="preview-scroll">
          <div class="stage" :style="stageStyle">
            <img ref="imgEl" :src="background" alt="Outpaint background" :style="imgStyle" @load="onImgLoad" />
          </div>
        </div>
        <div class="size-readout mono faint">
          {{ expanded.w }} × {{ expanded.h }} px
        </div>

        <div class="slider-grid">
          <label class="slider-row">
            <span>Left</span>
            <input v-model.number="left" type="range" min="0" :max="EDGE_MAX" :step="SNAP" />
            <span class="mono faint">{{ left }}</span>
          </label>
          <label class="slider-row">
            <span>Right</span>
            <input v-model.number="right" type="range" min="0" :max="EDGE_MAX" :step="SNAP" />
            <span class="mono faint">{{ right }}</span>
          </label>
          <label class="slider-row">
            <span>Top</span>
            <input v-model.number="top" type="range" min="0" :max="EDGE_MAX" :step="SNAP" />
            <span class="mono faint">{{ top }}</span>
          </label>
          <label class="slider-row">
            <span>Bottom</span>
            <input v-model.number="bottom" type="range" min="0" :max="EDGE_MAX" :step="SNAP" />
            <span class="mono faint">{{ bottom }}</span>
          </label>
        </div>
      </div>

      <footer class="dialog-footer">
        <label class="chk override" title="Run at the session's resolution instead of the expanded size">
          <input v-model="override" type="checkbox" />
          Override Resolution
        </label>
        <span class="faint hint">Adjust strength to 1.0 in Sampling for better results.</span>
        <button @click="clear()">Clear</button>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="!hasExpand || saving" @click="save()">
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
  width: min(640px, 94vw);
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
.preview-scroll {
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 120px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
/* White background = the painted-border preview; the image sits centered. */
.stage {
  position: relative;
  background: #ffffff;
  flex-shrink: 0;
}
.stage img {
  position: absolute;
  display: block;
}
.size-readout {
  text-align: center;
  font-size: 12px;
}
.slider-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.slider-row > span:first-child {
  flex-shrink: 0;
  width: 48px;
  font-size: 12px;
  color: var(--text-dim);
}
.slider-row > span:last-child {
  flex-shrink: 0;
  width: 36px;
  text-align: right;
  font-size: 12px;
}
.slider-row input[type='range'] {
  flex: 1;
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
