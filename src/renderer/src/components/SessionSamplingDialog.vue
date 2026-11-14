<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  SAMPLER_METHODS,
  SCHEDULER_MODEL_DEFAULT,
  SCHEDULERS,
  SEED_MAX,
  applySamplingOverrides,
  isValidSeed
} from '@shared/types'
import { FALLBACK_SAMPLING } from '@shared/types'
import type { SamplingDefaults, SessionSamplingOverride } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'

const props = defineProps<{ sessionName: string }>()
const emit = defineEmits<{ save: [draft: SessionSamplingOverride | null]; close: [] }>()

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()

const diffusionType = computed(() => appStore.configs?.sampling ? Object.keys(appStore.configs.sampling)[0] : '')

// The merged sampling for the active session: the descriptor defaults, the
// settings per-type overrides, then the session override — all through the
// shared flat-scalar-into-descriptor merge.
const merged = computed<SamplingDefaults | null>(() => {
  // The saved family (the NEW `family` key) wins; the legacy `diffusionType`
  // key and then the live composer selection follow.
  const dt =
    sessionsStore.active?.inputs?.family ??
    sessionsStore.active?.inputs?.diffusionType ??
    diffusionType.value
  // Complete the configured entry over the shared fallback — an entry may
  // predate a descriptor key (boogu_image lacks `control_video`) and the
  // dialog's row gates read the descriptors directly.
  const cfg = appStore.configs
  if (!cfg) return null
  const base = { ...FALLBACK_SAMPLING, ...(cfg.sampling[dt] ?? {}) }
  const global = settingsStore.samplingFor(dt, base)
  return applySamplingOverrides(global, sessionsStore.active?.inputs?.sampling)
})

// Row visibility: the descriptor's `show` flag gates the session-override row
// (defaults still apply even when the row is hidden).
const show = (key: 'steps' | 'high_steps' | 'cfg' | 'high_cfg' | 'strength' | 'sampler' | 'high_sampler' | 'scheduler' | 'flow_shift' | 'frames' | 'frame_rate' | 'upscale' | 'upscaler_steps' | 'model_args'): boolean =>
  merged.value?.[key]?.show ?? true

const draft = reactive<SessionSamplingOverride>({
  steps: null,
  high_steps: null,
  cfg: null,
  high_cfg: null,
  strength: null,
  sampler: '',
  high_sampler: '',
  scheduler: SCHEDULER_MODEL_DEFAULT,
  flow_shift: '',
  frames: null,
  frame_rate: null,
  seed: null,
  upscale: false,
  upscaler_steps: null,
  modelArgs: '',
  args: ''
})

// ---------- seed ----------
/** Dropdown view over draft.seed: null = random, a valid integer = fixed.
 *  A view, not a second persisted field — only draft.seed is saved. */
const seedMode = ref<'random' | 'fixed'>('random')
/** Last valid fixed seed seen in this dialog session — restored when the user
 *  toggles back to fixed (declared before onMounted uses it). */
let lastFixed: number | null = null

// Same math as main's randomSeed() in sdcli.ts: 32-bit unsigned range.
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}

watch(seedMode, (mode, prevMode) => {
  if (mode === 'fixed') {
    // Restoring the remembered value matters: an accidental
    // fixed → random → fixed round-trip must NOT mint a fresh seed. Only a
    // first-time switch with nothing remembered generates one (rerollable via
    // the dice button or editable in the input).
    draft.seed = lastFixed ?? randomSeed()
  } else if (mode === 'random') {
    if (prevMode === 'fixed' && isValidSeed(draft.seed)) lastFixed = draft.seed
    draft.seed = null
  }
})

function save(): void {
  // Materialize the FULL effective snapshot: the draft was seeded from the
  // merged descriptor (sampling.json defaults ← settings overrides ← the
  // session's previous override) and carries the user's edits on top, so
  // every save re-grounds the session in the CURRENT sampling.json — an app
  // update that changes the defaults is picked up on the next save instead
  // of a stale value surviving forever.
  const out: SessionSamplingOverride = { ...draft }
  // A cleared number input yields '' (v-model.number) — normalize to null
  // ("auto"): the session stores null and the CLI honors only non-empty,
  // non-null sampling settings (the flag is omitted at spawn).
  const nz = (v: unknown): number | null =>
    v === '' || v === undefined || v === null ? null : (v as number)
  out.steps = nz(draft.steps)
  out.high_steps = nz(draft.high_steps)
  out.cfg = nz(draft.cfg)
  out.high_cfg = nz(draft.high_cfg)
  out.strength = nz(draft.strength)
  out.frames = nz(draft.frames)
  out.frame_rate = nz(draft.frame_rate)
  out.upscaler_steps = nz(draft.upscaler_steps)
  out.sampler = draft.sampler || null
  out.high_sampler = draft.high_sampler || null
  // Model args: '' / null ⇒ no flag (the session stores null and main omits
  // --model-args at spawn); a non-empty trimmed string is preserved.
  out.modelArgs = (draft.modelArgs?.trim() || null)
  // Universal args: '' / null ⇒ nothing appended at spawn; a non-empty
  // trimmed string is preserved (main splits it into tokens).
  out.args = (draft.args?.trim() || null)
  const s = out.seed
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0) {
    // Clamp positives into sd-cli's 32-bit range rather than discarding the
    // user's intent; only '' / negative fall back to random.
    out.seed = Math.min(Math.floor(s), SEED_MAX)
  } else {
    out.seed = null
  }
  emit('save', out)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  // Prefill once the reactive sources are populated.
  await nextTick()
  const m = merged.value
  if (m) {
    // Optional chaining on the MoE-only descriptors (high_cfg / high_sampler):
    // most sampling.json types omit them entirely — only VACE defines them —
    // so an unguarded `.default` read throws in this mounted hook.
    // Nullable descriptors (steps / high_steps / cfg / high_cfg / strength /
    // sampler) seed an EMPTY field when the merged default is null ("auto") —
    // saving stores null ⇒ the whitelist deletes the key ⇒ the descriptor
    // default applies ⇒ the flag is omitted at spawn (sd-cli's own default).
    // Never seed a hardcoded value: saving would persist an override the
    // user never chose.
    draft.steps = m.steps.default ?? null
    draft.high_steps = m.high_steps?.default ?? null
    draft.cfg = m.cfg.default
    draft.high_cfg = m.high_cfg?.default ?? null
    draft.strength = m.strength.default
    draft.sampler = m.sampler.default ?? ''
    draft.high_sampler = m.high_sampler?.default ?? ''
    // Normalize a null/undefined global to the sentinel so the select has a
    // matching option (never a blank select).
    draft.scheduler = m.scheduler.default || SCHEDULER_MODEL_DEFAULT
    // Normalize a null/undefined global to '' so an empty field displays
    // (empty = explicit "none": no --flow-shift flag for this session).
    draft.flow_shift = m.flow_shift.default ?? ''
    draft.frames = m.frames.default ?? null
    draft.frame_rate = m.frame_rate.default ?? null
    // Highres fix (LTX): the checkbox prefills from the merged descriptor
    // default; a null upscaler_steps renders as an empty number input
    // (clearing the input ⇒ '' ⇒ the whitelist stores null ⇒ --hires-steps
    // omitted).
    draft.upscale = m.upscale?.default ?? false
    draft.upscaler_steps = m.upscaler_steps?.default ?? null
    // Model args: the merged descriptor default (a concrete string or null);
    // null ⇒ an empty field (empty = explicit "none": no --model-args flag).
    draft.modelArgs = m.model_args?.default ?? ''
    // Universal args: session-only (never a sampling.json field) — prefill
    // from the saved session override; absent ⇒ an empty field.
    draft.args = sessionsStore.active?.inputs?.sampling?.args ?? ''
    // Seed is session-only (never a sampling.json field): a valid stored
    // integer prefills fixed; anything else is random. Assign draft.seed and
    // lastFixed BEFORE the seedMode assignment — Vue watchers flush
    // asynchronously, so the watch below sees both set and restores the same
    // value instead of clobbering it.
    const storedSeed = sessionsStore.active?.inputs?.sampling?.seed
    draft.seed = isValidSeed(storedSeed) ? storedSeed : null
    if (draft.seed !== null) lastFixed = draft.seed
    seedMode.value = draft.seed === null ? 'random' : 'fixed'
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

function reset(): void {
  emit('save', null)
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Sampling override">
      <header class="dialog-header">
        <h2>Sampling override</h2>
        <span class="muted faint">{{ props.sessionName }}</span>
        <button class="icon close" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="dialog-body">
        <p class="faint">Applies to this session regardless of model — Reset to clear.</p>

        <!-- Rows render dynamically from the descriptor's `show` flags (the
             defaults still apply for hidden rows — only the override UI is
             gated). High-noise / video rows appear for the WAN families. -->
        <label v-if="show('steps')" class="kv-row">
          <span>Steps</span>
          <input v-model.number="draft.steps" type="number" min="1" max="200" />
        </label>
        <label v-if="show('high_steps')" class="kv-row">
          <span>High-noise steps</span>
          <input v-model.number="draft.high_steps" type="number" min="0" max="200" />
        </label>
        <label v-if="show('cfg')" class="kv-row">
          <span>CFG scale</span>
          <input v-model.number="draft.cfg" type="number" step="0.1" min="0" />
        </label>
        <label v-if="show('high_cfg')" class="kv-row">
          <span>High-noise CFG</span>
          <input v-model.number="draft.high_cfg" type="number" step="0.1" min="0" />
        </label>
        <label v-if="show('strength')" class="kv-row">
          <span>Strength</span>
          <input v-model.number="draft.strength" type="number" step="0.05" min="0" max="1" />
        </label>
        <label v-if="show('sampler')" class="kv-row">
          <span>Sampler</span>
          <select v-model="draft.sampler">
            <option value="">(model default)</option>
            <option v-for="s in SAMPLER_METHODS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label v-if="show('high_sampler')" class="kv-row">
          <span>High-noise sampler</span>
          <select v-model="draft.high_sampler">
            <option value="">(model default)</option>
            <option v-for="s in SAMPLER_METHODS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label v-if="show('scheduler')" class="kv-row">
          <span>Scheduler</span>
          <select v-model="draft.scheduler">
            <option value="model-specific">model-specific</option>
            <option v-for="s in SCHEDULERS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label v-if="show('flow_shift')" class="kv-row">
          <span>Flow shift</span>
          <input v-model.number="draft.flow_shift" type="number" step="0.1" placeholder="(none)" />
        </label>
        <p v-if="show('flow_shift')" class="faint">Flow shift: empty = no --flow-shift flag (model default); 0 is a real value.</p>
        <label v-if="show('frames')" class="kv-row">
          <span>Video frames</span>
          <input v-model.number="draft.frames" type="number" min="0" step="1" />
        </label>
        <label v-if="show('frame_rate')" class="kv-row">
          <span>Frame rate (fps)</span>
          <input v-model.number="draft.frame_rate" type="number" min="0" max="255" step="1" />
        </label>
        <label v-if="show('upscale')" class="kv-row">
          <span>Upscale</span>
          <input v-model="draft.upscale" type="checkbox" />
        </label>
        <p v-if="show('upscale')" class="faint">Highres fix: second upscale+refine pass (output is 2× the selected resolution).</p>
        <label v-if="show('upscaler_steps')" class="kv-row">
          <span>Upscaler steps</span>
          <input v-model.number="draft.upscaler_steps" type="number" min="0" step="1" placeholder="(reuse steps)" />
        </label>
        <p v-if="show('upscaler_steps')" class="faint">Upscaler steps: empty or 0 = reuse the main steps count for the refine pass.</p>
        <label v-if="show('model_args')" class="kv-row">
          <span>Model Args</span>
          <input v-model="draft.modelArgs" type="text" placeholder="(none)" />
        </label>
        <p v-if="show('model_args')" class="faint">Model args: free-form key=value list passed as --model-args (e.g. chroma_use_dit_mask). Empty = no flag.</p>
        <label class="kv-row">
          <span>Seed</span>
          <input
            v-model.number="draft.seed"
            type="number"
            min="0"
            :max="SEED_MAX"
            step="1"
            :disabled="seedMode === 'random'"
            placeholder="(random)"
          />
          <select v-model="seedMode" class="seed-mode">
            <option value="random">random</option>
            <option value="fixed">fixed</option>
          </select>
          <button
            v-if="seedMode === 'fixed'"
            class="dice"
            title="New random seed"
            aria-label="New random seed"
            @click.prevent="draft.seed = randomSeed()"
          >🎲</button>
        </label>
        <p class="faint">Seed: random = a new seed every generation; fixed = reuse this seed (dice rerolls it).</p>
        <!-- Universal args — the very last row: a free-form sd-cli CLI string
             appended after every app-emitted flag (user args win on
             duplicates), for flags the UI does not expose yet. -->
        <label class="kv-row">
          <span>Args</span>
          <input v-model="draft.args" type="text" placeholder="(none)" />
        </label>
        <p class="faint">Args: free-form sd-cli arguments appended to every generation (e.g. --flow-match on --cfg-rescale 0.7). Empty = none.</p>
      </div>

      <footer class="dialog-footer">
        <button @click="reset()">Reset</button>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" @click="save()">Save</button>
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
  width: min(560px, 92vw);
  max-height: min(80vh, 720px);
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
.dialog-header .muted {
  margin-left: auto;
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
  overflow-y: auto;
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
.kv-row .seed-mode {
  flex: 0 0 auto;
  width: 96px;
}
.kv-row .dice {
  flex: 0 0 auto;
  padding: 5px 9px;
  font-size: 14px;
  line-height: 1;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  cursor: pointer;
}
.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
