<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { SCHEDULER_MODEL_DEFAULT, SCHEDULERS } from '@shared/types'
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
  scheduler: SCHEDULER_MODEL_DEFAULT
})

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
      </div>

      <footer class="dialog-footer">
        <button @click="reset()">Reset</button>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" @click="emit('save', { ...draft })">Save</button>
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
.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
