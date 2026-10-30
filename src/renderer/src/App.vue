<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppStore } from './stores/app'
import { useSessionsStore } from './stores/sessions'
import { useSettingsStore } from './stores/settings'
import { applyTheme } from './theme'
import Sidebar from './components/Sidebar.vue'
import ChatPanel from './components/ChatPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ImageLightbox from './components/ImageLightbox.vue'
import InitOverlay from './components/InitOverlay.vue'
import Toasts from './components/Toasts.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import BatSplash from './components/BatSplash.vue'
import SnowSplash from './components/SnowSplash.vue'

const appStore = useAppStore()
const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()

const settingsOpen = ref(false)
const sidebarWidth = ref(Number(localStorage.getItem('sidebarWidth') ?? 260))
const dragging = ref(false)
// Startup-only bat splash (Halloween theme only): shown once, then dismissed
// on completion. The default blue theme never shows one.
const showBatSplash = ref(false)
// Startup-only snow splash (Christmas theme only): shown once, then dismissed
const showSnowSplash = ref(false)

function startDrag(e: MouseEvent): void {
  dragging.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value
  const move = (ev: MouseEvent): void => {
    sidebarWidth.value = Math.min(480, Math.max(180, startW + (ev.clientX - startX)))
  }
  const up = (): void => {
    dragging.value = false
    localStorage.setItem('sidebarWidth', String(sidebarWidth.value))
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

onMounted(async () => {
  // Register event listeners FIRST, then pull the current init state so we
  // catch up on any pipeline progress that happened before this page mounted
  // (the pipeline can finish before Vue mounts, in which case all the
  // init:status / app:ready events were lost).
  window.api.onInitStatus((s) => {
    appStore.initStage = s.stage
    appStore.initMessage = s.message
    if (s.platform) appStore.platform = s.platform
    if (s.downloadedBytes !== undefined) {
      appStore.initProgress = { downloadedBytes: s.downloadedBytes, totalBytes: s.totalBytes ?? 0 }
    }
  })
  window.api.onAppReady(async () => {
    appStore.ready = true
    appStore.initStage = 'done'
    // The init pipeline can finish (and write the catalog) after the renderer
    // mounted, in which case the initial loadCatalog() above got null and the
    // init.ready-gated refetch never fired. Reload now that the pipeline is done.
    if (!appStore.catalog) await appStore.loadCatalog()
  })
  window.api.onRuntimeProgress((p) => {
    settingsStore.runtimeDownloading = {
      version: p.version,
      downloadedBytes: p.downloadedBytes,
      totalBytes: p.totalBytes,
      phase: p.phase
    }
  })
  window.api.onModelsProgress((p) => {
    settingsStore.modelDownloads[`${p.type}:${p.url}`] = p
  })
  window.api.onHubProgress((p) => {
    appStore.catalogMessage = p.message
  })
  // Forward the full downloads:list payload to the settings store. The store's
  // refresh (refresh + prune) has no other registration point — this matches the
  // existing pattern where App.vue owns all onXxx listeners.
  window.api.onDownloadsChanged((list) => {
    void settingsStore.applyDownloadsList(list)
  })
  // Apply themes broadcast from main (window.api.setTheme) live.
  window.api.onThemeChange((key) => {
    settingsStore.theme = key
    applyTheme(key)
    // Bat splash only appears with the halloween theme.
    showBatSplash.value = key === 'halloween'
    // Snow splash only appears with the christmas theme.
    showSnowSplash.value = key === 'christmas'
  })

  const init = await window.api.initState()
  appStore.initStage = init.stage
  appStore.initMessage = init.message
  if (init.platform) appStore.platform = init.platform
  if (init.downloadedBytes !== undefined) {
    appStore.initProgress = { downloadedBytes: init.downloadedBytes, totalBytes: init.totalBytes ?? 0 }
  }
  appStore.ready = init.ready

  await appStore.loadConfigs()
  await appStore.loadCatalog()
  // If the pipeline finished (and wrote the catalog) before we loaded it,
  // the first loadCatalog() raced ahead of the file and got null — refetch.
  if (init.ready && !appStore.catalog) await appStore.loadCatalog()
  await appStore.loadAbout()
  await settingsStore.load()
  // Restore the persisted theme now that settings are loaded.
  settingsStore.applyPersistedTheme()
  // The bat splash is a halloween-only startup effect.
  showBatSplash.value = settingsStore.theme === 'halloween'
  // The snow splash is a christmas-only startup effect.
  showSnowSplash.value = settingsStore.theme === 'christmas'
  await sessionsStore.load()
})

</script>

<template>
  <div class="app" :class="{ dragging }">
    <Sidebar :width="sidebarWidth" @open-settings="settingsOpen = true" />
    <div class="divider" @mousedown="startDrag($event)"></div>
    <ChatPanel class="chat" />
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    <ImageLightbox />
    <InitOverlay v-if="!appStore.ready" />
    <ConfirmDialog />
    <Toasts />
  </div>
  <!-- Startup-only bat splash: halloween theme only, renders once, then dismisses on completion. -->
  <BatSplash v-if="showBatSplash" @complete="showBatSplash = false" />
  <!-- Startup-only snow splash: christmas theme only, renders once, then dismisses on completion. -->
  <SnowSplash v-if="showSnowSplash" @complete="showSnowSplash = false" />
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
  overflow: hidden;
}
.app.dragging {
  cursor: col-resize;
  user-select: none;
}
.divider {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.15s;
}
.divider:hover {
  background: var(--accent);
}
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
