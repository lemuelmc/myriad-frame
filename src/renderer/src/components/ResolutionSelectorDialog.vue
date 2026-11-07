<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ResolutionEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import {
  RATIO_CHIPS,
  MP_MIN,
  MP_MAX,
  MP_STEP,
  MP_DEFAULT,
  DIV_MIN,
  DIV_MAX,
  DIV_DEFAULT,
  DIM_MIN,
  DIM_MAX,
  ratioOf,
  snapTo,
  clampDimension,
  dimensionsFor,
  dimensionsForRatio,
  entryRatio,
  presetAspects,
  presetForChip,
  chipForEntry,
  matchesPresetDimensions
} from './resolutionMath'
import type { RatioChip } from './resolutionMath'

const props = defineProps<{ diffusionType: string; current: ResolutionEntry | null }>()
const emit = defineEmits<{ select: [ResolutionEntry]; close: [] }>()

const appStore = useAppStore()

const presets = computed<ResolutionEntry[]>(() => appStore.resolutionsFor(props.diffusionType))

// ---------- dialog state (committed only on Select) ----------
const chip = ref<RatioChip>('1:1')
const orientation = ref<'landscape' | 'portrait'>('landscape')
const mp = ref(MP_DEFAULT)
const div = ref(DIV_DEFAULT)
const width = ref(1024)
const height = ref(1024)

// Presets mode (chip 'presets'): dropdown-driven picks straight from the
// model's configured preset list — an aspect, then one of its presets.
const presetAspect = ref('')
const presetName = ref('')

/** Distinct aspect strings from the family's preset list, in file order. */
const presetAspectsList = computed<string[]>(() => presetAspects(presets.value))
/** Presets under the selected aspect, in file order. */
const presetsForAspect = computed<ResolutionEntry[]>(() =>
  presets.value.filter((p) => (p.aspect ?? '') === presetAspect.value)
)
/** The preset currently selected in Presets mode (null while unset). */
const selectedPreset = computed<ResolutionEntry | null>(
  () => presetsForAspect.value.find((p) => p.name === presetName.value) ?? null
)
/** Chips on display — 'presets' is only offered when the family has presets. */
const chips = computed<RatioChip[]>(() =>
  RATIO_CHIPS.filter((c) => c !== 'presets' || presets.value.length > 0)
)

const PREVIEW_MAX = 220

/**
 * Guards the mp watcher against programmatic writes: seeding mp from a
 * preset (or syncing it from edited dimensions) must not re-trigger the
 * pure-math recompute, which would overwrite the just-seeded dimensions.
 */
let suppressMpWatch = false

/** Effective megapixels of the current dimensions (unclamped). */
function effectiveMp(): number {
  const w = width.value
  const h = height.value
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return MP_DEFAULT
  return (w * h) / 1_000_000
}

/** Set the mp slider from dimensions without triggering the recompute watch. */
function syncMpFromDims(): void {
  suppressMpWatch = true
  mp.value = Math.min(MP_MAX, Math.max(MP_MIN, effectiveMp()))
  suppressMpWatch = false
}

/** The ratio the locked-mode math currently follows: the picked chip's
 *  ratio, the selected preset's exact w/h in Presets mode, or null when
 *  unconstrained (Custom / no preset selected). */
function effectiveRatio(): number | null {
  if (chip.value === 'custom') return null
  if (chip.value === 'presets') {
    const p = selectedPreset.value
    return p ? entryRatio(p) : null
  }
  return ratioOf(chip.value)
}

/** Seed dimensions + mp from the model's preset for a chip/orientation,
 *  falling back to pure math at 1.0 MP when the list has no such preset. */
function seedFromPreset(c: RatioChip, orient: 'landscape' | 'portrait'): void {
  const preset = presetForChip(c, orient, presets.value)
  if (preset) {
    width.value = preset.width
    height.value = preset.height
    syncMpFromDims()
  } else {
    const d = dimensionsFor(c, MP_DEFAULT, div.value)
    if (d) {
      width.value = d.width
      height.value = d.height
      syncMpFromDims()
    }
  }
}

function pickChip(c: RatioChip): void {
  chip.value = c
  if (c === 'custom') return
  if (c === 'presets') {
    seedPresetSelection()
    return
  }
  seedFromPreset(c, orientation.value)
}

/** Enter Presets mode: preselect the preset matching the current dimensions
 *  when one exists, else the first aspect's first preset, then seed dims. */
function seedPresetSelection(): void {
  const aspects = presetAspectsList.value
  if (aspects.length === 0) return
  const exact = presets.value.find((p) => p.width === width.value && p.height === height.value)
  if (exact && exact.aspect) {
    presetAspect.value = exact.aspect
    presetName.value = exact.name
  } else {
    presetAspect.value = aspects[0]
    const first = presets.value.find((p) => (p.aspect ?? '') === aspects[0])
    if (first) presetName.value = first.name
  }
  seedFromSelectedPreset()
}

/** Apply the selected preset's exact dimensions (no-op without a selection). */
function seedFromSelectedPreset(): void {
  const p = selectedPreset.value
  if (!p) return
  width.value = p.width
  height.value = p.height
  syncMpFromDims()
}

// MP slider: recompute both dimensions from pure math at the new MP, keeping
// the ratio, then snap. The step grid applies to user drags only — seeded
// off-step values (e.g. a 1.33 MP preset) display as-is.
watch(mp, (v) => {
  if (suppressMpWatch || chip.value === 'custom' || !Number.isFinite(v)) return
  const ratio = effectiveRatio()
  if (ratio === null) return
  const clamped = Math.min(MP_MAX, Math.max(MP_MIN, v))
  const d = dimensionsForRatio(ratio, clamped, div.value)
  width.value = d.width
  height.value = d.height
})

// Divisible-by: re-derive from pure math at the current effective MP (avoids
// compounding snap drift); in Custom mode re-snap the independent values.
watch(div, (n) => {
  if (chip.value === 'custom') {
    width.value = snapTo(width.value, n)
    height.value = snapTo(height.value, n)
    return
  }
  const ratio = effectiveRatio()
  if (ratio === null) return
  const d = dimensionsForRatio(ratio, effectiveMp(), n)
  width.value = d.width
  height.value = d.height
})

// Presets mode dropdowns: an aspect swap reselects the aspect's first preset
// (keeping an exact-match selection that is still valid), a preset swap
// applies its exact dimensions.
watch(presetAspect, () => {
  if (chip.value !== 'presets') return
  if (!presetsForAspect.value.some((p) => p.name === presetName.value)) {
    const first = presetsForAspect.value[0]
    if (first) presetName.value = first.name
  }
  seedFromSelectedPreset()
})

watch(presetName, () => {
  if (chip.value !== 'presets') return
  seedFromSelectedPreset()
})

// Orientation: re-seed from the model's preset for the new orientation
// (preset fidelity); swap w/h when the list has no such preset. No-op for
// 1:1 and Custom (the dropdown is disabled there anyway).
watch(orientation, (o) => {
  if (chip.value === 'custom' || chip.value === '1:1' || chip.value === 'presets') return
  const preset = presetForChip(chip.value, o, presets.value)
  if (preset) {
    width.value = preset.width
    height.value = preset.height
    syncMpFromDims()
  } else {
    const w = width.value
    width.value = height.value
    height.value = w
  }
})

// W/H edits commit on change (blur / Enter): clamp the edited field and, in
// locked mode, recompute the counterpart from the ratio. Live typing only
// moves the preview — clamping mid-keystroke would fight the user.
function onWidthCommit(): void {
  width.value = clampDimension(width.value)
  const ratio = effectiveRatio()
  if (ratio) {
    height.value = snapTo(width.value / ratio, div.value)
  }
  syncMpFromDims()
}

function onHeightCommit(): void {
  height.value = clampDimension(height.value)
  const ratio = effectiveRatio()
  if (ratio) {
    width.value = snapTo(height.value * ratio, div.value)
  }
  syncMpFromDims()
}

// ---------- live preview ----------
const previewStyle = computed(() => {
  const w = Number.isFinite(width.value) && width.value > 0 ? width.value : 1
  const h = Number.isFinite(height.value) && height.value > 0 ? height.value : 1
  const scale = Math.min(PREVIEW_MAX / w, PREVIEW_MAX / h)
  return {
    width: `${Math.max(12, Math.round(w * scale))}px`,
    height: `${Math.max(12, Math.round(h * scale))}px`
  }
})

const pixelCount = computed(() => {
  const w = Number.isFinite(width.value) ? width.value : 0
  const h = Number.isFinite(height.value) ? height.value : 0
  return (w * h).toLocaleString()
})

// ---------- commit ----------
/** Build the committed entry. Dimension-matching picks reuse the preset's
 *  canonical name; everything else gets a generated name. Always a fresh
 *  plain object — never a Pinia-reactive proxy — so session persistence's
 *  structured clone stays safe. */
function buildEntry(): ResolutionEntry {
  const w = width.value
  const h = height.value
  if (matchesPresetDimensions({ name: '', width: w, height: h }, presets.value)) {
    const preset = presets.value.find((p) => p.width === w && p.height === h)
    if (preset) return { name: preset.name, width: w, height: h }
  }
  if (chip.value !== 'custom') {
    const label = chip.value === 'presets' ? presetAspect.value || 'Preset' : chip.value
    return { name: `${label} · ${effectiveMp().toFixed(2)} MP`, width: w, height: h }
  }
  return { name: `Custom ${w}×${h}`, width: w, height: h }
}

function select(): void {
  // Re-anchor from width in locked mode: a pending un-blurred edit (change
  // event not yet fired) must still produce a ratio-consistent pair.
  const w = clampDimension(width.value)
  const ratio = chip.value === 'custom' ? null : effectiveRatio()
  if (ratio) {
    width.value = w
    height.value = snapTo(w / ratio, div.value)
  } else {
    height.value = clampDimension(height.value)
  }
  emit('select', buildEntry())
}

// ---------- lifecycle ----------
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  const entry = props.current
  if (entry && Number.isFinite(entry.width) && Number.isFinite(entry.height) && entry.width > 0 && entry.height > 0) {
    const mapped = chipForEntry(entry, presets.value)
    chip.value = mapped.chip
    orientation.value = mapped.orientation
    width.value = entry.width
    height.value = entry.height
    if (mapped.chip !== 'custom') syncMpFromDims()
  } else {
    chip.value = '1:1'
    orientation.value = 'landscape'
    seedFromPreset('1:1', 'landscape')
  }
  div.value = DIV_DEFAULT
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

// A model switch under an open dialog invalidates the preset space — close.
watch(
  () => props.diffusionType,
  () => emit('close')
)
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Resolution">
      <header class="dialog-header">
        <h2>Resolution</h2>
        <span class="muted faint">{{ presets.length }} presets</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <div class="chip-row" role="group" aria-label="Aspect ratio">
          <button
            v-for="c in chips"
            :key="c"
            class="ratio-chip"
            :class="{ active: chip === c }"
            @click="pickChip(c)"
          >
            {{ c === 'custom' ? 'Custom' : c === 'presets' ? 'Presets' : c }}
          </button>
        </div>

        <template v-if="chip === 'presets'">
          <label class="kv-row">
            <span>Aspect</span>
            <select v-model="presetAspect">
              <option v-for="a in presetAspectsList" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label class="kv-row">
            <span>Preset</span>
            <select v-model="presetName">
              <option v-for="p in presetsForAspect" :key="p.name" :value="p.name">
                {{ p.label || p.name }} · {{ p.width }}×{{ p.height }}
              </option>
            </select>
          </label>
        </template>

        <label v-if="chip !== 'presets'" class="kv-row">
          <span>Orientation</span>
          <select v-model="orientation" :disabled="chip === '1:1' || chip === 'custom'">
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
        </label>

        <div class="dim-row">
          <label class="kv-row">
            <span>Width</span>
            <input
              v-model.number="width"
              type="number"
              :min="DIM_MIN"
              :max="DIM_MAX"
              step="1"
              @change="onWidthCommit"
            />
          </label>
          <label class="kv-row">
            <span>Height</span>
            <input
              v-model.number="height"
              type="number"
              :min="DIM_MIN"
              :max="DIM_MAX"
              step="1"
              @change="onHeightCommit"
            />
          </label>
        </div>
        <p v-if="chip === 'presets'" class="faint">
          Presets from resolution.json — pick an aspect, then one of its presets.
        </p>
        <p v-else-if="chip !== 'custom'" class="faint">
          Aspect ratio locked to {{ chip }} — editing one dimension recomputes the other.
        </p>
        <p v-else class="faint">Custom — width and height are independent.</p>

        <label v-if="chip !== 'custom'" class="kv-row">
          <span>Megapixels</span>
          <input v-model.number="mp" type="range" :min="MP_MIN" :max="MP_MAX" :step="MP_STEP" />
          <span class="mono slider-label">{{ mp.toFixed(2) }} MP</span>
        </label>

        <label class="kv-row">
          <span>Divisible by</span>
          <input v-model.number="div" type="range" :min="DIV_MIN" :max="DIV_MAX" step="1" />
          <span class="mono slider-label">{{ div === 0 ? 'no snap' : `×${div}` }}</span>
        </label>

        <div class="preview-area">
          <div class="preview-box" :style="previewStyle"></div>
          <span class="mono preview-label">{{ width }}×{{ height }} · {{ pixelCount }} px</span>
        </div>
      </div>

      <footer class="dialog-footer">
        <button @click="emit('close')">Cancel</button>
        <button class="primary" @click="select()">Select</button>
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
  width: min(480px, 92vw);
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
}
.chip-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ratio-chip {
  padding: 5px 12px;
  font-size: 13px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text);
  cursor: pointer;
}
.ratio-chip.active {
  border-color: var(--accent, var(--text));
  font-weight: 600;
}
.kv-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.kv-row > span {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-dim);
}
.kv-row input,
.kv-row select {
  flex: 1;
  min-width: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  color: var(--text);
  font-size: 13px;
}
.kv-row input[type='range'] {
  padding: 0;
  accent-color: var(--accent, currentColor);
}
.slider-label {
  flex: 0 0 72px;
  text-align: right;
  font-size: 12px;
  color: var(--text-dim);
}
.dim-row {
  display: flex;
  gap: 12px;
}
.dim-row .kv-row {
  flex: 1;
}
.preview-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 0 4px;
}
.preview-box {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: width 0.05s linear, height 0.05s linear;
}
.preview-label {
  font-size: 12px;
  color: var(--text-dim);
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
