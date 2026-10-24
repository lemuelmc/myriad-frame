<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface Props {
  downloadedBytes: number
  totalBytes: number
  /** Text shown next to the spinner. Defaults to "Downloading…" */
  label?: string
  /** Single-line variant for tight spaces (spinner + bar + % only) */
  compact?: boolean
  /** Phase of the operation; overrides the default label when no explicit label is given */
  phase?: 'downloading' | 'extracting'
}

const props = withDefaults(defineProps<Props>(), { label: '', compact: false, phase: 'downloading' })

const phaseLabel = computed(() => {
  if (props.label) return props.label
  return props.phase === 'extracting' ? 'Extracting…' : 'Downloading…'
})

// ---- speed tracking (sliding window of recent progress samples) ----
const samples = ref<{ t: number; b: number }[]>([])
const speedBps = ref(0)
let timer: number | null = null

function pushSample(): void {
  const now = Date.now()
  const s = samples.value
  s.push({ t: now, b: props.downloadedBytes })
  while (s.length > 500 || (s.length > 0 && now - s[0].t > 5000)) s.shift()
}

function tick(): void {
  const s = samples.value
  if (s.length < 2) return
  const a = s[0]
  const z = s[s.length - 1]
  const dt = (z.t - a.t) / 1000
  if (dt >= 0.5) speedBps.value = Math.max(0, (z.b - a.b) / dt)
}

onMounted(() => {
  pushSample()
  timer = window.setInterval(tick, 500)
})
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})
watch(() => props.downloadedBytes, pushSample)

// ---- derived display values ----
const pct = computed(() =>
  props.totalBytes ? Math.min(100, Math.round((props.downloadedBytes / props.totalBytes) * 100)) : 0
)
const indeterminate = computed(() => !props.totalBytes)

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

const speedLabel = computed(() => (speedBps.value > 0 ? `${fmtBytes(speedBps.value)}/s` : ''))
</script>

<template>
  <div class="dl-progress" :class="{ compact }">
    <span class="dl-spinner"></span>
    <span class="dl-label">{{ phaseLabel }}</span>
    <div class="dl-bar">
      <div
        class="dl-bar-fill"
        :class="{ indeterminate }"
        :style="totalBytes ? { width: pct + '%' } : undefined"
      ></div>
    </div>
    <span v-if="totalBytes" class="dl-pct mono">{{ pct }}%</span>
    <span class="dl-meta mono">
      {{ fmtBytes(downloadedBytes) }}<template v-if="totalBytes"> / {{ fmtBytes(totalBytes) }}</template>
      <template v-if="speedLabel"> · {{ speedLabel }}</template>
    </span>
  </div>
</template>

<style scoped>
.dl-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dl-progress.grow {
  flex: 1;
  min-width: 160px;
}
.dl-spinner {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 2px solid var(--accent-soft);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: dl-spin 0.9s linear infinite;
}
@keyframes dl-spin {
  to {
    transform: rotate(360deg);
  }
}
.dl-label {
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}
.dl-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-hover);
  border-radius: 999px;
  overflow: hidden;
  min-width: 60px;
}
.dl-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.2s ease;
}
.dl-bar-fill.indeterminate {
  width: 40%;
  animation: dl-slide 1.2s ease-in-out infinite;
}
@keyframes dl-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}
.dl-pct {
  font-size: 12px;
  color: var(--accent);
  min-width: 34px;
  text-align: right;
}
.dl-meta {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
/* compact: spinner + bar + % only */
.dl-progress.compact .dl-label,
.dl-progress.compact .dl-meta {
  display: none;
}
.dl-progress.compact .dl-bar {
  flex: 0 0 56px;
  min-width: 56px;
}
</style>
