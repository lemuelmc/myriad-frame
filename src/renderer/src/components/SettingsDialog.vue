<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CatalogEntry, ModelType, PerformanceSettings, RuntimeKey, SamplingDefaults } from '@shared/types'
import { useAppStore } from '../stores/app'
import { defaultPerformance, useSettingsStore, type ModelDownloadState } from '../stores/settings'
import { toast } from '../toast'
import { confirm } from '../confirm'
import DownloadProgress from './DownloadProgress.vue' 
import logoWide from '../../../assets/logo-wide-small.png'

const emit = defineEmits<{ close: [] }>()
const appStore = useAppStore()
const settingsStore = useSettingsStore() 

type Section = 'about' | 'models' | 'vae' | 'encoder' | 'vision' | 'sampling' | 'runtime' | 'performance'
const section = ref<Section>('about') 

const sections: { id: Section; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'models', label: 'Models' },
  { id: 'vae', label: 'VAE' },
  { id: 'encoder', label: 'Text Encoder' },
  { id: 'vision', label: 'Vision' },
  { id: 'sampling', label: 'Sampling' },
  { id: 'performance', label: 'Performance' },
  { id: 'runtime', label: 'Runtime' }
] 

const diffusionTypes = computed(() =>
  [...new Set((appStore.catalog?.entries ?? []).map((e) => e.diffusionType))]
) 

// ---------- models (diffusion only) ----------
const modelFiles = computed(() => settingsStore.modelLists.diffusion ?? [])
const diffusionEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === 'diffusion' && !e.name.startsWith('text_encoders/') && !e.name.startsWith('vae/')
  )
)
/**
 * Resolve a provider key (e.g. 'unsloth') to its human-readable label using
 * the top-level `providers` map in hub.json. Falls back to the key itself, or
 * 'Unknown' when no provider key is present.
 */
function providerLabel(key: string | undefined): string {
  if (!key) return 'Unknown'
  const providers = appStore.configs?.hub.providers ?? []
  for (const p of providers) {
    if (Object.prototype.hasOwnProperty.call(p, key)) return p[key].label
  }
  return key
}
const providerGroups = computed(() => {
  const map = new Map<string, CatalogEntry[]>()
  for (const e of diffusionEntries.value) {
    const p = providerLabel(e.provider)
    const arr = map.get(p) ?? []
    arr.push(e)
    map.set(p, arr)
  }
  return [...map.entries()]
})
const installedNames = computed(() => new Set(modelFiles.value.map((f) => f.name)))
async function refreshHub(): Promise<void> {
  try {
    await appStore.refreshCatalog()
  } catch (err) {
    toast(`Hub refresh failed: ${(err as Error).message}`, 'error')
  }
}
async function downloadEntry(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('diffusion', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/**
 * Force a redownload of a model that is already installed. `force` makes the
 * download flow re-download even when the file already exists with a matching
 * size, replacing the on-disk file.
 */
async function redownloadEntry(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('diffusion', e.url, e.provider, true)
    toast(`Redownloaded ${e.name}`, 'ok')
  } catch (err) {
    toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
async function removeModel(name: string): Promise<void> {
  const ok = await confirm(`Delete ${name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('diffusion', name)
}
function dlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`diffusion:${e.url}`]
}
function catalogEntryFor(type: ModelType, name: string): CatalogEntry | undefined {
  return (appStore.catalog?.entries ?? []).find((e) => e.type === type && e.name === name)
}
function installedDlState(type: ModelType, name: string) {
  const e = catalogEntryFor(type, name)
  return e ? settingsStore.modelDownloads[`${type}:${e.url}`] : undefined
}
function diffusionTypeForName(name: string): string | undefined {
  return diffusionEntries.value.find((e) => e.name === name)?.diffusionType
}
function defaultDepEntry(type: ModelType, dt: string): CatalogEntry | undefined {
  const entries = (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === type && e.diffusionType === dt
  )
  if (!entries.length) return undefined
  return entries.find((e) => e.isDefault) ?? entries[0]
}
function dependencyEntries(dt: string): CatalogEntry[] {
  const v = defaultDepEntry('vae', dt)
  const enc = defaultDepEntry('encoder', dt)
  const vis = defaultDepEntry('vision', dt)
  return [v, enc, vis].filter((x): x is CatalogEntry => Boolean(x))
}
const depDownloads = computed(() => {
  const out: { key: string; label: string; state: ModelDownloadState }[] = []
  const seen = new Set<string>()
  for (const f of modelFiles.value) {
    const dt = diffusionTypeForName(f.name)
    if (!dt) continue
    for (const e of dependencyEntries(dt)) {
      const key = `${e.type}:${e.url}`
      if (seen.has(key)) continue
      const s = settingsStore.modelDownloads[key]
      if (s) {
        seen.add(key)
        out.push({ key, label: e.name, state: s })
      }
    }
  }
  return out
})
async function downloadDependencies(name: string): Promise<void> {
  const dt = diffusionTypeForName(name)
  if (!dt) {
    toast('Could not determine the diffusion type for this model', 'error')
    return
  }
  const deps = dependencyEntries(dt)
  if (!deps.length) {
    toast('No dependencies configured for this diffusion type', 'info')
    return
  }
  let missing = 0
  for (const e of deps) {
    const installed = settingsStore.modelLists[e.type]?.some((f) => f.name === e.name)
    if (!installed) {
      missing++
      try {
        await settingsStore.downloadModel(e.type, e.url, e.provider)
        toast(`Downloaded ${e.name}`, 'ok')
      } catch (err) {
        toast(`Download failed: ${(err as Error).message}`, 'error')
      }
    }
  }
  if (!missing) toast('All dependencies already installed', 'ok')
  else toast(`Downloaded ${missing} of ${deps.length} dependencies`, 'ok')
} 

// ---------- vae ----------
const vaeType = ref(diffusionTypes.value[0] ?? '')
const vaeEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'vae' && e.diffusionType === vaeType.value)
)
const defaultVae = computed(() => settingsStore.settings.defaultVae?.[vaeType.value] ?? '')
async function setDefaultVae(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultVae ?? {}) }
  if (name) map[vaeType.value] = name
  else delete map[vaeType.value]
  await settingsStore.save({ defaultVae: map })
} 

// ---------- encoder ----------
const encoderType = ref(diffusionTypes.value[0] ?? '')
const encoderFiles = computed(() => settingsStore.modelLists.encoder ?? [])
const encoderEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'encoder' && e.diffusionType === encoderType.value)
)
const encoderInstalledNames = computed(() => new Set(encoderFiles.value.map((f) => f.name)))
const defaultEncoder = computed(() => settingsStore.settings.defaultEncoder?.[encoderType.value] ?? '')
async function setDefaultEncoder(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultEncoder ?? {}) }
  if (name) map[encoderType.value] = name
  else delete map[encoderType.value]
  await settingsStore.save({ defaultEncoder: map })
}
async function downloadEncoder(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('encoder', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
async function removeEncoder(name: string): Promise<void> {
  const ok = await confirm(`Delete ${name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('encoder', name)
}
function encoderDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`encoder:${e.url}`]
} 

// ---------- vision (mmproj) ----------
const visionType = ref(diffusionTypes.value[0] ?? '')
const visionFiles = computed(() => settingsStore.modelLists.vision ?? [])
const visionEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'vision' && e.diffusionType === visionType.value)
)
const visionInstalledNames = computed(() => new Set(visionFiles.value.map((f) => f.name)))
const defaultVision = computed(() => settingsStore.settings.defaultVision?.[visionType.value] ?? '')
async function setDefaultVision(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultVision ?? {}) }
  if (name) map[visionType.value] = name
  else delete map[visionType.value]
  await settingsStore.save({ defaultVision: map })
}
async function downloadVision(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('vision', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
async function removeVision(name: string): Promise<void> {
  const ok = await confirm(`Delete ${name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('vision', name)
}
function visionDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`vision:${e.url}`]
}
function visionHasEntries(): boolean {
  return [...new Set((appStore.catalog?.entries ?? []).map((e) => e.diffusionType))].some((dt) =>
    (appStore.catalog?.entries ?? []).some((e) => e.type === 'vision' && e.diffusionType === dt)
  )
} 

// ---------- sampling ----------
const samplingType = ref(diffusionTypes.value[0] ?? '')
const samplingBase = computed<SamplingDefaults | null>(() => appStore.configs?.sampling[samplingType.value] ?? null)
const samplingOverride = ref<Partial<SamplingDefaults>>({})
function loadOverride(): void {
  samplingOverride.value = { ...(settingsStore.settings.sampling?.[samplingType.value] ?? {}) }
}
watch(samplingType, loadOverride)
async function saveSampling(): Promise<void> {
  const map = { ...(settingsStore.settings.sampling ?? {}) }
  if (Object.keys(samplingOverride.value).length) map[samplingType.value] = samplingOverride.value
  else delete map[samplingType.value]
  await settingsStore.save({ sampling: map })
  toast('Sampling saved', 'ok')
}
function resetSampling(): void {
  samplingOverride.value = {}
  void saveSampling()
} 

// ---------- performance ----------
const perf = ref<PerformanceSettings>(settingsStore.performance)
// Persist every v-model mutation so the flags survive a reload (debounced).
// Do NOT sync back from settingsStore.performance: its getter returns a fresh
// object each time, which would re-trigger this watcher and loop forever.
let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => perf.value,
  () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void savePerformance()
    }, 400)
  },
  { deep: true }
)
async function savePerformance(): Promise<void> {
  // `perf.value` is a deeply reactive Proxy (Vue ref). A shallow spread leaves
  // nested objects (e.g. `vaeTiling`) as reactive Proxies, which
  // `ipcRenderer.invoke` cannot structured-clone. JSON round-trip unwraps every
  // level into a plain, serializable object before it crosses the preload bridge.
  const payload = JSON.parse(JSON.stringify({ performance: { ...perf.value } }))
  try {
    await settingsStore.save(payload)
    toast('Performance settings saved', 'ok')
  } catch (err) {
    toast(`Failed to save performance settings: ${(err as Error).message}`, 'error')
  }
}

// ---------- runtime ----------
const platform = computed(() => appStore.platform)
const recommendedKey = computed<RuntimeKey | undefined>(() => platform.value?.runtimeKey)
const selectedVersion = computed(() => settingsStore.selectedVersion)
async function selectVersion(v: string): Promise<void> {
  await settingsStore.save({ runtimeVersion: v })
}
async function downloadRuntime(v: string): Promise<void> {
  const key = recommendedKey.value
  if (!key) {
    toast('Could not determine platform runtime key', 'error')
    return
  }
  try {
    await settingsStore.downloadRuntime(v, key)
    toast(`Runtime ${v} ready`, 'ok')
  } catch (err) {
    toast(`Runtime download failed: ${(err as Error).message}`, 'error')
  }
}
function fmtBytes(n: number): string {
  if (!n) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
} 

onMounted(async () => {
  await settingsStore.listModels('diffusion')
  await settingsStore.listModels('encoder')
  await settingsStore.listModels('vae')
  await settingsStore.listModels('vision')
  loadOverride()
})
</script> 

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog-header">
        <h2>Settings</h2>
        <button class="icon" title="Close" @click="emit('close')">×</button>
      </header>
      <div class="dialog-body">
        <nav class="dialog-nav">
          <button
            v-for="s in sections"
            :key="s.id"
            :class="{ active: section === s.id }"
            @click="section = s.id"
          >
            {{ s.label }}
          </button>
        </nav> 

        <div class="dialog-content">
          <!-- ABOUT -->
          <section v-if="section === 'about'">
            <div class="about-section">
              <img :src="logoWide" alt="Myriad Frame" class="about-logo" />
            </div>
            <h3>About</h3>
            <table class="kv">
              <tbody>
                <tr><td>Application</td><td>{{ appStore.about?.name ?? 'Myriad Frame' }}</td></tr>
                <tr><td>Version</td><td>{{ appStore.about?.version }}</td></tr>
                <tr><td>Platform</td><td>{{ appStore.about?.platform }}</td></tr>
                <tr v-if="platform">
                  <td>GPU</td>
                  <td>{{ platform.gpu }}<template v-if="platform.gpuDetail"> ({{ platform.gpuDetail }})</template></td>
                </tr>
                <tr>
                                  <td>Engine</td>
                                  <td class="mono">stable-diffusion.cpp</td>
                                  </tr>
                                  </tbody>
                                  </table>
                                  <div class="about-footer">By: Lemuel Raganas</div>
                                  </section>

          <!-- MODELS -->
          <section v-if="section === 'models'">
            <div class="section-head">
              <h3>Diffusion models</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p> 

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in modelFiles" :key="f.name">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <button
                  class="icon"
                  title="Download dependencies (VAE, text encoder, vision)"
                  @click="downloadDependencies(f.name)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
                  </svg>
                </button>
                <button class="icon danger" title="Delete" @click="removeModel(f.name)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!modelFiles.length" class="muted">No models downloaded yet.</li>
            </ul> 

            <div v-if="depDownloads.length" class="dep-dl">
              <DownloadProgress
                v-for="d in depDownloads"
                :key="d.key"
                class="grow"
                :label="`Downloading dependency · ${d.label}`"
                :downloaded-bytes="d.state.downloadedBytes"
                :total-bytes="d.state.totalBytes"
              />
            </div> 

            <h4>Available from hub</h4>
            <div v-for="[provider, entries] in providerGroups" :key="provider" class="provider-group">
              <h5>{{ provider }}</h5>
              <ul class="file-list">
                <li v-for="e in entries" :key="e.id" class="dl-item">
                  <div class="dl-item-top">
                    <span class="mono">{{ e.name }}</span>
                    <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                    <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                    <template v-if="installedNames.has(e.name)">
                      <span class="ok-tag">installed</span>
                      <button
                        class="icon"
                        title="Force redownload"
                        :disabled="!!dlState(e)"
                        @click="redownloadEntry(e)"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 2v6h-6M3 22v-6h6" />
                          <path d="M21 13A9 9 0 0 0 5.2 7.2M3 11a9 9 0 0 0 15.8 5.8" />
                        </svg>
                      </button>
                    </template>
                    <template v-else>
                      <button
                        v-if="dlState(e)"
                        class="dl-btn"
                        disabled
                        :title="`${dlState(e)!.downloadedBytes} / ${dlState(e)!.totalBytes} downloaded`"
                      >
                        Downloading…
                      </button>
                      <button v-else class="dl-btn" @click="downloadEntry(e)">Download</button>
                    </template>
                  </div>
                  <DownloadProgress
                    v-if="dlState(e)"
                    class="grow"
                    :downloaded-bytes="dlState(e)!.downloadedBytes"
                    :total-bytes="dlState(e)!.totalBytes"
                  />
                </li>
              </ul>
            </div>
            <p v-if="!providerGroups.length" class="muted">
              No diffusion models in the catalog. Use "Refresh hub" to scan the repositories.
            </p>
          </section> 

          <!-- VAE -->
          <section v-if="section === 'vae'">
            <h3>VAE</h3>
            <label class="muted">Diffusion type</label>
            <select v-model="vaeType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>
            <p class="muted">
              Choose the default VAE used for {{ vaeType }}. Download it from the VAE dropdown in the chat composer.
            </p>
            <ul class="file-list">
              <li v-for="e in vaeEntries" :key="e.id">
                <span class="mono">{{ e.name }}</span>
                <DownloadProgress
                  v-if="installedDlState('vae', e.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('vae', e.name)!.downloadedBytes"
                  :total-bytes="installedDlState('vae', e.name)!.totalBytes"
                />
                <button
                  class="set-default"
                  :class="{ active: defaultVae === e.name }"
                  @click="setDefaultVae(e.name)"
                >
                  {{ defaultVae === e.name ? 'Default' : 'Set default' }}
                </button>
              </li>
              <li v-if="!vaeEntries.length" class="muted">No VAE entries for this diffusion type.</li>
            </ul>
          </section> 

          <!-- ENCODER -->
          <section v-if="section === 'encoder'">
            <div class="section-head">
              <h3>Text Encoder</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p> 

            <label class="muted">Diffusion type</label>
            <select v-model="encoderType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select> 

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in encoderFiles" :key="f.name">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <DownloadProgress
                  v-if="installedDlState('encoder', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('encoder', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('encoder', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeEncoder(f.name)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!encoderFiles.length" class="muted">No text encoders downloaded yet.</li>
            </ul> 

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in encoderEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="encoderInstalledNames.has(e.name)">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="encoderDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${encoderDlState(e)!.downloadedBytes} / ${encoderDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadEncoder(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultEncoder === e.name }"
                    @click="setDefaultEncoder(e.name)"
                  >
                    {{ defaultEncoder === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="encoderDlState(e)"
                  class="grow"
                  :downloaded-bytes="encoderDlState(e)!.downloadedBytes"
                  :total-bytes="encoderDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!encoderEntries.length" class="muted">No text encoder entries for this diffusion type.</li>
            </ul>
          </section> 

          <!-- VISION (mmproj) -->
          <section v-if="section === 'vision' && visionHasEntries()">
            <div class="section-head">
              <h3>Vision (mmproj)</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p> 

            <p class="muted">
              The vision (mmproj) model bridges the diffusion transformer to the text encoder. Only present for
              diffusion types that declare a vision dependency.
            </p> 

            <label class="muted">Diffusion type</label>
            <select v-model="visionType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select> 

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in visionFiles" :key="f.name">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <DownloadProgress
                  v-if="installedDlState('vision', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('vision', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('vision', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeVision(f.name)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!visionFiles.length" class="muted">No vision models downloaded yet.</li>
            </ul> 

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in visionEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="visionInstalledNames.has(e.name)">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="visionDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${visionDlState(e)!.downloadedBytes} / ${visionDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadVision(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultVision === e.name }"
                    @click="setDefaultVision(e.name)"
                  >
                    {{ defaultVision === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="visionDlState(e)"
                  class="grow"
                  :downloaded-bytes="visionDlState(e)!.downloadedBytes"
                  :total-bytes="visionDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!visionEntries.length" class="muted">No vision entries for this diffusion type.</li>
            </ul>
          </section> 

          <!-- SAMPLING -->
          <section v-if="section === 'sampling'">
            <h3>Sampling</h3>
            <label class="muted">Diffusion type</label>
            <select v-model="samplingType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>
            <p v-if="!samplingBase" class="muted">No sampling defaults configured for {{ samplingType }}.</p>
            <table v-else class="kv">
              <tbody>
                <tr>
                  <td>Steps</td>
                  <td><input v-model.number="samplingOverride.steps" type="number" min="1" max="100" style="width: 90px" /></td>
                </tr>
                <tr>
                  <td>CFG scale</td>
                  <td><input v-model.number="samplingOverride.cfg" type="number" step="0.1" min="0" style="width: 90px" /></td>
                </tr>
                <tr>
                  <td>Sampler</td>
                  <td>
                    <input v-model="samplingOverride.sampler" type="text" style="width: 160px" />
                  </td>
                </tr>
                <tr>
                  <td>Width</td>
                  <td><input v-model.number="samplingOverride.width" type="number" min="1" style="width: 90px" /></td>
                </tr>
                <tr>
                  <td>Height</td>
                  <td><input v-model.number="samplingOverride.height" type="number" min="1" style="width: 90px" /></td>
                </tr>
              </tbody>
            </table>
            <p class="faint">
              Defaults from sampling.json: {{ samplingBase ? JSON.stringify(samplingBase) : '—' }}
            </p>
            <div class="row">
              <button class="primary" @click="saveSampling()">Save overrides</button>
              <button @click="resetSampling()">Reset to defaults</button>
            </div>
          </section> 

          <!-- PERFORMANCE -->
          <section v-if="section === 'performance'">
            <h3>Performance</h3>
            <p class="muted">
              Global inference flags applied to every generation. Values are written to the sd-cli
              command line; adjust them to trade off memory usage and speed for your hardware.
            </p>
            <table class="kv">
              <tbody>
                <tr>
                  <td>Enable</td>
                  <td>
                    <input v-model="perf.enabled" type="checkbox" />
                    <span class="faint">Apply performance configuration to every generation.</span>
                  </td>
                </tr>
                <tr>
                  <td>Flash Attention</td>
                  <td>
                    <select v-model="perf.flashAttention">
                      <option value="off">Off</option>
                      <option value="on">On</option>
                      <option value="auto">Auto</option>
                    </select>
                    <span class="faint">Enabling flash attention may reduce memory usage depending on the architecture.</span>
                  </td>
                </tr>
                <tr>
                  <td>Direct Convolution</td>
                  <td>
                    <select v-model="perf.convDirect">
                      <option value="off">Off</option>
                      <option value="on">On</option>
                      <option value="auto">Auto</option>
                    </select>
                    <span class="faint">Depending on GPU, enabling can either improve or reduce speed.</span>
                  </td>
                </tr>
                <tr>
                  <td>VAE Tile Size</td>
                  <td>
                    <select v-model="perf.vaeTiling.tileSize">
                      <option value="off">Off</option>
                      <option value="256x256">256×256</option>
                      <option value="512x512">512×512</option>
                    </select>
                    <span class="faint">Reduce encode and decode memory usage.</span>
                  </td>
                </tr>
                <tr>
                  <td>VAE Tile Overlap</td>
                  <td>
                    <input v-model.number="perf.vaeTiling.overlap" type="number" step="0.05" min="0" max="1" style="width: 90px" />
                    <span v-if="perf.vaeTiling.tileSize !== 'off'" class="faint">Only applied when tile size is not Off.</span>
                  </td>
                </tr>
                <tr>
                  <td>Force CPU Offload</td>
                  <td>
                    <select v-model="perf.offloadToCpu">
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                    <span class="faint">Force weights offload to CPU to save VRAM without reducing generation speed.</span>
                  </td>
                </tr>
                <tr>
                  <td>Param Backend</td>
                  <td>
                    <div class="row">
                      <select v-model="perf.paramBackend" style="width: 140px">
                        <option value="off">Off</option>
                        <option value="cpu">CPU</option>
                        <option value="gpu">GPU</option>
                        <option value="disk">Disk</option>
                        <option value="custom">Custom</option>
                      </select>
                      <input
                        v-if="perf.paramBackend === 'custom'"
                        v-model="perf.paramBackendCustom"
                        type="text"
                        placeholder="custom backend"
                        style="width: 160px"
                      />
                    </div>
                    <span class="faint">Choose where to load parameters to reduce VRAM/RAM usage.</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="faint">
              Changes are saved automatically once you stop editing, then applied to
              every generation.
            </p>
          </section> 

          <!-- RUNTIME -->
          <section v-if="section === 'runtime'">
            <h3>Runtime</h3>
            <table class="kv">
              <tbody>
                <tr><td>Detected OS</td><td>{{ platform?.os ?? '—' }}</td></tr>
                <tr><td>Detected GPU</td><td>{{ platform?.gpu ?? '—' }}<template v-if="platform?.gpuDetail"> ({{ platform.gpuDetail }})</template></td></tr>
                <tr><td>Recommended runtime</td><td class="mono">{{ recommendedKey }}</td></tr>
              </tbody>
            </table> 

            <h4>Versions</h4>
            <ul class="file-list">
              <li v-for="v in settingsStore.runtimeVersions" :key="v.version">
                <span class="mono">v{{ v.version }}</span>
                <span v-if="v.installed" class="ok-tag">installed</span>
                <span v-else class="faint">not installed</span>
                <template v-if="settingsStore.runtimeDownloading?.version === v.version">
                  <DownloadProgress
                    class="grow"
                    :downloaded-bytes="settingsStore.runtimeDownloading!.downloadedBytes"
                    :total-bytes="settingsStore.runtimeDownloading!.totalBytes"
                    :phase="settingsStore.runtimeDownloading!.phase"
                  />
                </template>
                <template v-else>
                  <button
                    v-if="!v.installed"
                    class="dl-btn"
                    @click="downloadRuntime(v.version)"
                  >
                    Download
                  </button>
                </template>
                <button
                  class="set-default"
                  :class="{ active: selectedVersion === v.version }"
                  :disabled="!v.installed"
                  @click="selectVersion(v.version)"
                >
                  {{ selectedVersion === v.version ? 'Selected' : 'Select' }}
                </button>
              </li>
            </ul>
            <p class="faint">
              The selected runtime is used for generation. Downloads are stored under
              <span class="mono">{{ 'data/runtime/<version>/' }}</span>.
            </p>
          </section>
          </div>
      </div>
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
  width: min(860px, 92vw);
  height: min(620px, 88vh);
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
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 {
  margin: 0;
  font-size: 16px;
}
.dialog-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.dialog-nav {
  width: 150px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dialog-nav button {
  text-align: left;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
}
.dialog-nav button:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.dialog-nav button.active {
  background: var(--bg-panel);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}
.dialog-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 12px;
}
.dialog-content h3 {
  margin-top: 0;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.provider-group h5 {
  margin: 10px 0 2px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.quant-tag {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 6px;
}
.about-section {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}
.about-logo {
  max-width: 260px;
  width: 100%;
  height: auto;
  object-fit: contain;
}
.about-section {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}
.about-logo {
  max-width: 260px;
  width: 100%;
  height: auto;
  object-fit: contain;
}
.about-footer {
  margin-top: 16px;
  text-align: right;
  color: #736f6f;
  font-size: 12px;
}
.kv {
  width: 100%;
  border-collapse: collapse;
}
.kv td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.kv td:first-child {
  color: var(--text-dim);
  width: 160px;
}
.kv td select,
.kv td input[type="text"] {
  margin-right: 8px;
}
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.tabs button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.file-list {
  list-style: none;
  margin: 8px 0 16px;
  padding: 0;
}
.file-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border);
}
.file-list li.dl-item {
  align-items: flex-start;
  flex-direction: column;
  gap: 6px;
}
.dl-item-top {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.dl-item-top .mono {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list li .mono {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ok-tag {
  color: var(--ok);
  font-size: 12px;
}
.dl-btn {
  padding: 3px 10px;
  font-size: 12px;
}
.dl-progress.grow {
  flex: 1;
  min-width: 160px;
}
.set-default {
  padding: 3px 10px;
  font-size: 12px;
}
.set-default.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
}
.dep-dl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 4px 0;
}
</style>
