<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Startup-only snow splash (Christmas theme only).
 *
 * Spawns up to MAX_SNOW snowflakes from the top edge. Each flake starts above
 * the viewport, drifts downward with a horizontal wobble and a slow rotation,
 * and fades out as it crosses the bottom. The overlay self-dismisses (emitting
 * `complete`) once every flake has finished, capped by MAX_LIFETIME so it can
 * never hang past the init overlay.
 *
 * Renderer-only decoration; nothing here crosses IPC.
 */

const DEFAULT_SNOW = 50    // default number of falling snowflakes
const MAX_SNOW = 120      // hard cap on concurrent flakes

const STAGGER = 60        // ms between each flake's launch
const MAX_LIFETIME = 8000 // hard cap so the splash can't outlive app init

interface Flake {
  id: number
  x: number          // starting x offset % of window width (0–100)
  y: number          // current offset px from the top
  scale: number
  opacity: number
  rotation: number
  launched: boolean
  finished: boolean
  // per-flake parameters (all random)
  wobblePhase: number
  wobbleAmp: number
  wobbleFreq: number
  fallDistance: number
  duration: number
  launchAt: number
  rotationSpeed: number
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function makeFlake(id: number, launchAt: number): Flake {
  return {
    id,
    x: rand(2, 98),               // start anywhere across the width
    y: -20,                       // start just above the top edge
    scale: rand(0.5, 1.4),
    opacity: 0,
    rotation: rand(0, 360),
    launched: false,
    finished: false,
    wobblePhase: rand(0, Math.PI * 2),
    wobbleAmp: rand(8, 34),
    wobbleFreq: rand(1.2, 3.0),
    fallDistance: rand(1080, 1400), // clear the viewport height
    duration: rand(5000, 9000),
    launchAt,
    rotationSpeed: rand(-60, 60),
  }
}

const flakes = ref<Flake[]>([])
let raf = 0
let done = false
const emit = defineEmits<{ complete: [] }>()

function frame(now: number): void {
  if (done) return
  let allDone = true
  for (const f of flakes.value) {
    if (f.finished) continue
    allDone = false
    if (!f.launched) {
      if (now < f.launchAt) continue
      f.launched = true
    }
    const t = Math.min(1, (now - f.launchAt) / f.duration)
    // ease-in: snowflakes accelerate as they fall (gravity), gentle start
    const ease = t * t
    const wobX = Math.sin(t * f.wobbleFreq + f.wobblePhase) * f.wobbleAmp
    // fade in quickly, hold, then fade out near the bottom
    const opacity = t < 0.08
      ? t / 0.08
      : t > 0.8
        ? Math.max(0, 1 - (t - 0.8) / 0.2)
        : 1
    f.y = f.fallDistance * ease + wobX
    f.rotation = f.rotationSpeed * t
    f.opacity = opacity
    if (t >= 1) f.finished = true
  }
  if (allDone) {
    done = true
    emit('complete')
    return
  }
  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  const count = Math.min(MAX_SNOW, DEFAULT_SNOW)
  flakes.value = Array.from({ length: count }, (_, i) => makeFlake(i, i * STAGGER))
  raf = requestAnimationFrame(frame)
  // Safety net: never hang past app init even if a flake somehow never finishes.
  window.setTimeout(() => {
    if (!done) {
      done = true
      emit('complete')
    }
  }, MAX_LIFETIME)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="splash" role="presentation" aria-hidden="true">
    <div
      v-for="f in flakes"
      :key="f.id"
      class="flake"
      :style="{
        left: `${f.x}%`,
        transform: `translate(-50%, ${f.y.toFixed(1)}px) rotate(${f.rotation.toFixed(1)}deg)`,
        opacity: f.opacity,
      }"
    >❄</div>
  </div>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 4000;
  pointer-events: none;
}
.flake {
  position: absolute;
  top: 0;
  width: 16px;
  text-align: center;
  color: #ffffff;
  text-shadow: 0 0 3px rgba(180, 210, 225, 0.9);
  will-change: transform, opacity;
}
</style>
