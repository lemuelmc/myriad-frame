<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { SCHEDULER_MODEL_DEFAULT, SCHEDULERS, SEED_MAX, isValidSeed } from '@shared/types'
import type { SessionSamplingOverride } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'

const props = defineProps<{ sessionName: string }>()
const emit = defineEmits<{ save: [draft: SessionSamplingOverride | null]; close: [] }>()

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()

const diffusionType = computed(() => appStore.configs?.sampling ? Object.keys(appStore.configs.sampling)[0] : '')

// The merged sampling for the active session (session override wins over the
// global default).
const merged = computed(() => {
  const dt = sessionsStore.active?.inputs?.diffusionType ?? diffusionType.value
  const base = appStore.configs?.sampling[dt]
  if (!base) return null
  const global = settingsStore.samplingFor(dt, base)
  const so = sessionsStore.active?.inputs?.sampling
  return so ? { ...global, ...so } : global
})

const draft = reactive<SessionSamplingOverride>({
  steps: 25,
  cfg: 1.0,
  strength: 0.75,
  sampler: 'euler',
  scheduler: SCHEDULER_MODEL_DEFAULT,
  flow_shift: '',
  seed: null
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
  const out: SessionSamplingOverride = { ...draft }
  const s = out.seed
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0) {
    // Clamp positives into sd-cli's 32-bit range rather than discarding the
    // user's intent; only '' / negative fall back to random. (Main's
    // whitelist stays strict — it deletes invalid values instead.)
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
    draft.steps = m.steps
    draft.cfg = m.cfg
    draft.strength = m.strength
    draft.sampler = m.sampler ?? 'euler'
    // Normalize a null/undefined global to the sentinel so the select has a
    // matching option (never a blank select).
    draft.scheduler = m.scheduler || SCHEDULER_MODEL_DEFAULT
    // Normalize a null/undefined global to '' so an empty field displays
    // (empty = explicit "none": no --flow-shift flag for this session).
    draft.flow_shift = m.flow_shift ?? ''
    // Seed: a valid stored integer prefills fixed; anything else is random.
    // Assign draft.seed and lastFixed BEFORE the seedMode assignment — Vue
    // watchers flush asynchronously, so the watch below sees both set and
    // restores the same value instead of clobbering it.
    draft.seed = isValidSeed(m.seed) ? m.seed : null
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

        <label class="kv-row">
          <span>Steps</span>
          <input v-model.number="draft.steps" type="number" min="1" max="100" />
        </label>
        <label class="kv-row">
          <span>CFG scale</span>
          <input v-model.number="draft.cfg" type="number" step="0.1" min="0" />
        </label>
        <label class="kv-row">
          <span>Strength</span>
          <input v-model.number="draft.strength" type="number" step="0.05" min="0" max="1" />
        </label>
        <label class="kv-row">
          <span>Sampler</span>
          <select v-model="draft.sampler">
            <option v-for="s in ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde', 'dpm++2m_sde_bt', 'lms']" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="kv-row">
          <span>Scheduler</span>
          <select v-model="draft.scheduler">
            <option value="model-specific">model-specific</option>
            <option v-for="s in SCHEDULERS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="kv-row">
          <span>Flow shift</span>
          <input v-model.number="draft.flow_shift" type="number" step="0.1" placeholder="(none)" />
        </label>
        <p class="faint">Flow shift: empty = no --flow-shift flag (model default); 0 is a real value.</p>
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
