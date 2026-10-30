<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import BatImage from '../../../assets/bat-01.png'

/**
 * Startup-only bat splash.
 *
 * Spawns up to MAX_BATS bats from the center of the window. Each bat starts
 * tiny, flies off in a random direction while growing, then fades out. The
 * overlay self-dismisses (emitting `complete`) once every bat has finished its
 * flight, capped by MAX_LIFETIME so it can never hang past the init overlay.
 *
 * Renderer-only decoration; nothing here crosses IPC.
 */

const MAX_BATS = 6
const STAGGER = 220   // ms between each bat's launch
const MAX_LIFETIME = 6000 // hard cap so the splash can't outlive app init

interface Bat {
  id: number
  x: number        // current offset px from center
  y: number
  scale: number
  opacity: number
  rotation: number
  launched: boolean
  finished: boolean
  // per-bat flight parameters (all random)
  targetX: number
  targetY: number
  wobblePhase: number
  wobbleAmp: number
  wobbleFreq: number
  duration: number
  launchAt: number
  rotationSpeed: number
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function makeBat(id: number, launchAt: number): Bat {
  const angle = rand(0, Math.PI * 2)
  const distance = rand(180, 380)
  return {
    id,
    x: 0, y: 0, scale: 0.08, opacity: 0, rotation: 0,
    launched: false, finished: false,
    // drift slightly upward so the swarm feels like it's taking off
    targetX: Math.cos(angle) * distance,
    targetY: Math.sin(angle) * distance - 60,
    wobblePhase: rand(0, Math.PI * 2),
    wobbleAmp: rand(18, 48),
    wobbleFreq: rand(3.5, 6.5),
    duration: rand(2800, 4200),
    launchAt,
    rotationSpeed: rand(-240, 240),
  }
}

const bats = ref<Bat[]>([])
let raf = 0
let done = false
const emit = defineEmits<{ complete: [] }>()

function frame(now: number): void {
  if (done) return
  let allDone = true
  for (const b of bats.value) {
    if (b.finished) continue
    allDone = false
    if (!b.launched) {
      if (now < b.launchAt) continue
      b.launched = true
    }
    const t = Math.min(1, (now - b.launchAt) / b.duration)
    const ease = 1 - Math.pow(1 - t, 3) // ease-out cubic: fast start, gentle landing
    // grows from tiny to a bit larger as it flies
    const scale = t < 0.25
      ? 0.08 + (1.0 - 0.08) * (t / 0.25)
      : 1.0 + 0.35 * Math.min(1, (t - 0.25) / 0.75)
    // fades in, holds, then fades out
    const opacity = t < 0.12
      ? t / 0.12
      : t > 0.85
        ? Math.max(0, 1 - (t - 0.85) / 0.15)
        : 1
    const wobX = Math.sin(t * b.wobbleFreq + b.wobblePhase) * b.wobbleAmp
    const wobY = Math.cos(t * b.wobbleFreq + b.wobblePhase) * b.wobbleAmp
    b.x = b.targetX * ease + wobX
    b.y = b.targetY * ease + wobY
    b.scale = scale
    b.opacity = opacity
    b.rotation = b.rotationSpeed * t
    if (t >= 1) b.finished = true
  }
  if (allDone) {
    done = true
    emit('complete')
    return
  }
  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  bats.value = Array.from({ length: MAX_BATS }, (_, i) => makeBat(i, i * STAGGER))
  raf = requestAnimationFrame(frame)
  // Safety net: never hang past app init even if a bat somehow never finishes.
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
    <img
      v-for="b in bats"
      :key="b.id"
      :src="BatImage"
      class="bat"
      :style="{
        transform: `translate(calc(-50% + ${b.x.toFixed(1)}px), calc(-50% + ${b.y.toFixed(1)}px)) scale(${b.scale.toFixed(3)}) rotate(${b.rotation.toFixed(1)}deg)`,
        opacity: b.opacity,
      }"
    />
  </div>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 4000;
  pointer-events: none;
}
.bat {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 64px;
  height: auto;
  will-change: transform, opacity;
}
</style>
