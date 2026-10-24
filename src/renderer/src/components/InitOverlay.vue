<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'

const appStore = useAppStore()

const pct = computed(() => {
  const { downloadedBytes, totalBytes } = appStore.initProgress
  if (!totalBytes) return null
  return Math.round((downloadedBytes / totalBytes) * 100)
})
</script>

<template>
  <div class="overlay">
    <div class="card">
      <div class="spinner big"></div>
      <h1>Myriad Frame</h1>
      <p class="muted">{{ appStore.initMessage }}</p>
      <div v-if="pct !== null" class="progress">
        <div class="progress-fill" :style="{ width: pct + '%' }"></div>
      </div>
      <p v-if="pct !== null" class="faint mono">{{ pct }}%</p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}
.card {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-width: 320px;
}
.card h1 {
  margin: 0;
  font-size: 20px;
}
.card p {
  margin: 0;
}
.spinner.big {
  width: 44px;
  height: 44px;
  border-width: 4px;
}
.progress {
  width: 100%;
  height: 6px;
  background: var(--bg-panel);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
</style>
