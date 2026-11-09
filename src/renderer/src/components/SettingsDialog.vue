<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type {
  CatalogEntry,
  DownloadEntry,
  LlmSettings,
  ModelFile,
  ModelType,
  PerformanceSettings,
  RuntimeKey,
  SamplingDefaults,
  SamplingOverrideValues,
  TokenEntry
} from '@shared/types'
import {
  DOWNLOAD_ABORTED_MESSAGE,
  SCHEDULERS,
  SAMPLER_METHODS
} from '@shared/types'
import { useAppStore } from '../stores/app'
import { defaultPerformance, useSettingsStore, type ModelDownloadState } from '../stores/settings'
import { baseName, matchesSearch, normalizeForSearch, providerLabel } from '../search'
import { accessForFamily, requiredFamilyFor, resolveEncoderBundle } from '../deps'
import { toast } from '../toast'
import { confirm } from '../confirm'
import { listThemes } from '../theme'
import DownloadProgress from './DownloadProgress.vue'
import TokenEntryDialog from './TokenEntryDialog.vue'
import LoraBrowser from './LoraBrowser.vue'
import logoWide from '../../../assets/logo-wide-small.png'
import releaseNotesMd from '../../../../configurations/release-notes.md?raw'
import { marked } from 'marked'

const emit = defineEmits<{ close: [] }>()
const appStore = useAppStore()
const settingsStore = useSettingsStore() 

type Section = 'appearance' | 'about' | 'release-notes' | 'models' | 'vae' | 'encoder' | 'vision' | 'tokenizer' | 'audio_encoder' | 'audio_vae' | 'latent_upscaler' | 'lora' | 'llm_models' | 'llm_inference' | 'sampling' | 'runtime' | 'performance' | 'downloads' | 'tokens' | 'logs'
const section = ref<Section>('appearance')  // default to appearance instead of 'about'

const sections: { id: Section; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'release-notes', label: 'Release Notes' },
  { id: 'models', label: 'Models' },
  { id: 'vae', label: 'VAE' },
  { id: 'encoder', label: 'Text Encoder' },
  { id: 'vision', label: 'Vision' },
  { id: 'tokenizer', label: 'Tokenizer' },
  { id: 'audio_encoder', label: 'Audio Encoder' },
  { id: 'audio_vae', label: 'Audio VAE' },
  { id: 'latent_upscaler', label: 'Latent Upscaler' },
  { id: 'lora', label: 'LoRA' },
  { id: 'llm_models', label: 'Language Models' },
  { id: 'llm_inference', label: 'Language Inference' },
  { id: 'sampling', label: 'Sampling' },
  { id: 'performance', label: 'Performance' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'logs', label: 'Logs' }
]

/** Persist + apply the chosen theme. `settingsStore.theme` already reflects the
 * selection via v-model; this validates, applies, and persists the choice. */
function onThemeChange(): void {
  void settingsStore.setTheme(settingsStore.theme)
}

// ---------- release notes ----------
// configurations/release-notes.md is inlined at build time via Vite's ?raw
// suffix; marked renders it to HTML. The content is trusted (bundled with the
// app, never user input), so no sanitizer is layered on top. Links are forced
// to target="_blank" so the main process setWindowOpenHandler routes them to
// the system browser instead of navigating the Electron window away from the
// app.
const releaseNotesHtml = computed(() => {
  const md = releaseNotesMd.replace(/^#[^\n]*\n+/, '')
  return marked.parse(md, { async: false }).replace(/<a\s/g, '<a target="_blank" rel="noopener" ')
})

const diffusionTypes = computed(() =>
  [...new Set((appStore.catalog?.entries ?? []).map((e) => e.diffusionType))]
) 

// ---------- models (diffusion only) ----------
const modelFiles = computed(() => settingsStore.modelLists.diffusion ?? [])
const diffusionEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => {
    if (e.type !== 'diffusion') return false
    const lname = e.name.toLowerCase()
    // Exclude standalone VAE weights and LoRA adapters — neither is a selectable
    // diffusion checkpoint, even when scanned under a diffusion repo tree.
    if (lname.includes('vae') || lname.includes('lora') || lname.includes('text_encoders')) return false
    return !e.name.startsWith('text_encoders/') && !e.name.startsWith('vae/')
  })
)
// Providers come from the hub config; threaded explicitly into the shared
// search helpers (see ../search.ts).
const hubProviders = computed(() => appStore.configs?.hub.providers ?? [])
const providerGroups = computed(() => {
  const map = new Map<string, CatalogEntry[]>()
  for (const e of diffusionEntries.value) {
    const p = providerLabel(e.provider, hubProviders.value)
    const arr = map.get(p) ?? []
    arr.push(e)
    map.set(p, arr)
  }
  return [...map.entries()]
})
const installedNames = computed(() => new Set(modelFiles.value.map((f) => f.name)))

/**
 * Stable v-for key for an installed row (model-collision-hardening plan §6):
 * duplicate basenames previously collided as Vue keys — the composite
 * family/provider/name is unique per listed path.
 */
function rowKey(f: ModelFile): string {
  return `${f.diffusionType ?? ''}/${f.provider ?? ''}/${f.name}`
}

/** The `family · provider` subtitle for an installed row — empty for legacy
 *  flat rows (no context to show). */
function rowContext(f: ModelFile): string {
  return [f.diffusionType, f.provider].filter(Boolean).join(' · ')
}

/**
 * Models-section search filter. The needle is normalized (space, '-' and '_'
 * become equivalent) and trimmed so leading/trailing separators are dropped;
 * an empty needle (blank query, or separators only) means no filtering — the
 * filtered computeds return the full lists rather than matching a whitespace
 * needle. `installedNames` and `depDownloads` intentionally keep deriving from
 * the unfiltered `modelFiles`.
 */
const modelQuery = ref('')
const modelNeedle = computed(() => normalizeForSearch(modelQuery.value).trim())
const filteredModelFiles = computed(() => {
  const needle = modelNeedle.value
  if (!needle) return modelFiles.value
  return modelFiles.value.filter((f) => normalizeForSearch(f.name).includes(needle))
})
const filteredProviderGroups = computed(() => {
  const needle = modelNeedle.value
  if (!needle) return providerGroups.value
  const out: [string, CatalogEntry[]][] = []
  for (const [provider, entries] of providerGroups.value) {
    const hit = entries.filter((e) => matchesSearch(e, needle, hubProviders.value))
    if (hit.length) out.push([provider, hit])
  }
  return out
})
async function refreshHub(): Promise<void> {
  try {
    await appStore.refreshCatalog()
  } catch (err) {
    toast(`Hub refresh failed: ${(err as Error).message}`, 'error')
  }
}

// ---------- hub config update check (Models section) ----------
const hubChecking = ref(false)
const hubResetting = ref(false)
async function checkHubUpdates(): Promise<void> {
  hubChecking.value = true
  try {
    const result = await settingsStore.checkHubUpdates()
    if (result.updated) {
      if (result.addedModels.length) {
        let msg = `Hub config updated (new: ${result.addedModels.join(', ')})`
        if (result.removedModels.length) {
          msg += ` (removed: ${result.removedModels.join(', ')})`
        }
        toast(msg, 'ok')
      } else {
        // Content-only change (e.g. upstream fixed a download URL or bumped updatedOn).
        toast('Hub config updated', 'ok')
      }
      // The catalog cache was built from the previous config — rescan so the
      // "Available from hub" list reflects the new config without a second
      // click. Fire-and-forget: refreshHub() toasts its own scan failures,
      // and the real check outcome was already toasted above.
      void refreshHub()
    } else {
      toast('Hub config is up to date', 'ok')
    }
  } catch (err) {
    toast(`Check failed: ${(err as Error).message}`, 'error')
  } finally {
    hubChecking.value = false
  }
}
async function resetHubConfig(): Promise<void> {
  hubResetting.value = true
  try {
    await settingsStore.resetHubConfig()
    toast('Hub config reset to bundled', 'ok')
    // The catalog may have been built from the override — rescan so the
    // "Available from hub" list matches the bundled config again.
    void refreshHub()
  } catch (err) {
    toast(`Reset failed: ${(err as Error).message}`, 'error')
  } finally {
    hubResetting.value = false
  }
}
/**
 * True when the error is the manager's deliberate-cancel abort (Cancel/Pause
 * from the Downloads section) — its outcome was already toasted by the
 * canceling action, so it must not surface as a "download failed" error here.
 */
function isAbortedDownload(err: unknown): boolean {
  return (err as Error).message === DOWNLOAD_ABORTED_MESSAGE
}
/** Every catalog member of the entry's MoE group (same family + groupId), or
 *  the entry alone for plain single-file models. A MoE pair is not optional —
 *  downloading only the low-noise expert would make gen:start fail on the
 *  missing high-noise companion. */
function groupMembers(e: CatalogEntry): CatalogEntry[] {
  if (!e.groupId) return [e]
  return (appStore.catalog?.entries ?? []).filter(
    (x) => x.type === 'diffusion' && x.groupId === e.groupId && x.diffusionType === e.diffusionType
  )
}
async function downloadEntry(e: CatalogEntry): Promise<void> {
  try {
    const group = groupMembers(e)
    for (const m of group) await settingsStore.downloadModel('diffusion', m.url, m.provider)
    toast(
      group.length > 1 ? `Downloaded ${e.name} (+${group.length - 1} MoE companion)` : `Downloaded ${e.name}`,
      'ok'
    )
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/**
 * Force a redownload of a model that is already installed. `force` makes the
 * download flow re-download even when the file already exists with a matching
 * size, replacing the on-disk file. MoE groups redownload as a pair.
 */
async function redownloadEntry(e: CatalogEntry): Promise<void> {
  try {
    const group = groupMembers(e)
    for (const m of group) await settingsStore.downloadModel('diffusion', m.url, m.provider, true)
    toast(
      group.length > 1 ? `Redownloaded ${e.name} (+${group.length - 1} MoE companion)` : `Redownloaded ${e.name}`,
      'ok'
    )
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/**
 * Delete an installed row by its exact location: the ModelFile row carries
 * the provider/diffusionType context `models.list()` classified it with, so
 * main deletes ONE path (model-collision-hardening plan §3.3) instead of
 * every provider subdir matching the basename. List rows carry no url — no
 * chain fallback.
 */
async function removeModel(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('diffusion', f.name, f.provider, f.diffusionType)
}
function dlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`diffusion:${e.url}`]
}
function catalogEntryFor(type: ModelType, name: string): CatalogEntry | undefined {
  // Basename compare: a slashed catalog name matches its on-disk basename
  // after the manager's basename-normalized storage (plan §3.1).
  return (appStore.catalog?.entries ?? []).find(
    (e) => e.type === type && baseName(e.name) === baseName(name)
  )
}
function installedDlState(type: ModelType, name: string) {
  const e = catalogEntryFor(type, name)
  return e ? settingsStore.modelDownloads[`${type}:${e.url}`] : undefined
}
/**
 * Catalog description for an installed model file, resolved by file name —
 * the same lookup `installedDlState` uses. Undefined for files that are not
 * in the catalog (e.g. manually placed) — nothing renders then.
 */
function installedDesc(name: string): string | undefined {
  return catalogEntryFor('diffusion', name)?.description
}
function diffusionTypeForName(name: string): string | undefined {
  return diffusionEntries.value.find((e) => baseName(e.name) === baseName(name))?.diffusionType
}
/**
 * Access badge for a hub entry's diffusion family, from the FRESH hub config
 * (`diffusion_models[].access` via accessForFamily()): 'Auth' when downloads
 * need an API token, 'Gated' when a token AND accepting the terms/license on
 * the model page are required, null when freely downloadable. Rendered in
 * the same accent style as the CivitAI source badge — which is suppressed
 * while an access badge shows, since the access badge already covers the
 * token requirement.
 */
function accessBadge(e: CatalogEntry): 'Auth' | 'Gated' | null {
  const a = accessForFamily(e.diffusionType)
  if (!a) return null
  return a === 'gated' ? 'Gated' : 'Auth'
}
/** Hover text for the access badge — what it requires + where to configure the token. */
function accessTitle(e: CatalogEntry): string {
  return accessForFamily(e.diffusionType) === 'gated'
    ? 'Gated model — requires a token AND accepting the terms/license on the model page. Configure a token (Settings → Tokens)'
    : 'Requires authentication — configure a token (Settings → Tokens)'
}
function defaultDepEntry(type: ModelType, dt: string): CatalogEntry | undefined {
  const entries = (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === type && e.diffusionType === dt
  )
  if (!entries.length) return undefined
  return entries.find((e) => e.isDefault) ?? entries[0]
}
function dependencyEntries(dt: string): CatalogEntry[] {
  // `requires` blocks route the VAE / encoder / audio-encoder dependencies to
  // a DIFFERENT diffusion family (wan2_2_t2v uses the wan2_1 VAE + encoder;
  // S2V adds the wan2_2 audio encoder). Absent → the diffusion type itself.
  const vaeFamily = requiredFamilyFor(dt, 'vae')
  const encFamily = requiredFamilyFor(dt, 'encoder')
  const audFamily = requiredFamilyFor(dt, 'audio_encoder')
  const v = defaultDepEntry('vae', vaeFamily)
  // Encoder slot: a bundle diffusion type (`defaults[]`, SD3.5-style)
  // downloads the whole bundle. Prefer the config-resolved bundle — a
  // catalog-only lookup leaves bundle types with zero dependency entries
  // whenever the cached catalog is stale — then every `isDefault` encoder
  // entry from the catalog, then the plain single-entry fallback.
  const bundle = resolveEncoderBundle(encFamily)
  let enc: CatalogEntry[]
  if (bundle.length) {
    enc = bundle
  } else {
    const marked = (appStore.catalog?.entries ?? []).filter(
      (e) => e.type === 'encoder' && e.diffusionType === encFamily && e.isDefault
    )
    enc = marked.length
      ? marked
      : [defaultDepEntry('encoder', encFamily)].filter((x): x is CatalogEntry => Boolean(x))
  }
  const vis = defaultDepEntry('vision', dt)
  const tok = defaultDepEntry('tokenizer', dt)
  const aud = defaultDepEntry('audio_encoder', audFamily)
  // LTX 2.5 companions — resolved from the diffusion type ITSELF (no
  // `requires` indirection), so the per-family dependency bundle surfaced in
  // the Models section includes the audio VAE and the latent upscaler too.
  const av = defaultDepEntry('audio_vae', dt)
  const lu = defaultDepEntry('latent_upscaler', dt)
  return [v, ...enc, vis, tok, aud, av, lu].filter((x): x is CatalogEntry => Boolean(x))
}
const depDownloads = computed(() => {
  const out: { key: string; label: string; state: ModelDownloadState }[] = []
  const seen = new Set<string>()
  for (const f of modelFiles.value) {
    // The row's own classification wins (exact); the name lookup stays as the
    // fallback for rows listed before the metadata existed.
    const dt = f.diffusionType ?? diffusionTypeForName(f.name)
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
/**
 * Download the dependency set for an installed row. The row's own
 * `diffusionType` (from models.list()) is authoritative; the name lookup
 * stays as the fallback.
 */
async function downloadDependencies(f: ModelFile): Promise<void> {
  const dt = f.diffusionType ?? diffusionTypeForName(f.name)
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
    const installed = settingsStore.modelLists[e.type]?.some(
      (row) => baseName(row.name) === baseName(e.name)
    )
    if (!installed) {
      missing++
      try {
        await settingsStore.downloadModel(e.type, e.url, e.provider)
        toast(`Downloaded ${e.name}`, 'ok')
      } catch (err) {
        if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
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
/**
 * VAE-section search filter, mirroring the Models section: normalized
 * (space, '-' and '_' equivalent) + trimmed needle; an empty needle (blank
 * query or separators only) means no filtering. `defaultVae` is keyed by
 * name and unaffected by filtering.
 */
const vaeQuery = ref('')
const vaeNeedle = computed(() => normalizeForSearch(vaeQuery.value).trim())
const filteredVaeEntries = computed(() => {
  const needle = vaeNeedle.value
  if (!needle) return vaeEntries.value
  return vaeEntries.value.filter((e) => matchesSearch(e, needle, hubProviders.value))
})
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
/**
 * Encoder-section search filter, mirroring the Models section: normalized
 * (space, '-' and '_' equivalent) + trimmed needle; an empty needle (blank
 * query or separators only) means no filtering. `encoderInstalledNames` (the
 * "installed" tag on hub rows) keeps deriving from the unfiltered
 * `encoderFiles` so installed tags don't vanish while a query is active;
 * `defaultEncoder` is keyed by name and unaffected.
 */
const encoderQuery = ref('')
const encoderNeedle = computed(() => normalizeForSearch(encoderQuery.value).trim())
const filteredEncoderFiles = computed(() => {
  const needle = encoderNeedle.value
  if (!needle) return encoderFiles.value
  return encoderFiles.value.filter((f) => normalizeForSearch(f.name).includes(needle))
})
const filteredEncoderEntries = computed(() => {
  const needle = encoderNeedle.value
  if (!needle) return encoderEntries.value
  return encoderEntries.value.filter((e) => matchesSearch(e, needle, hubProviders.value))
})
const encoderInstalledNames = computed(() => new Set(encoderFiles.value.map((f) => f.name)))
const defaultEncoder = computed(() => settingsStore.settings.defaultEncoder?.[encoderType.value] ?? '')
// SD3.5-style bundle type (`defaults[]` present): the bundle is fixed by the
// config, so the per-file "Set default" control is meaningless and hidden.
const encoderIsBundle = computed(() => resolveEncoderBundle(encoderType.value).length > 0)
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
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/** Context-scoped delete (one path — see removeModel). */
async function removeEncoder(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('encoder', f.name, f.provider, f.diffusionType)
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
/**
 * Vision-section search filter, mirroring the Models section: normalized
 * (space, '-' and '_' equivalent) + trimmed needle; an empty needle (blank
 * query or separators only) means no filtering. `visionInstalledNames` (the
 * "installed" tag on hub rows) keeps deriving from the unfiltered
 * `visionFiles` so installed tags don't vanish while a query is active;
 * `defaultVision` is keyed by name and unaffected.
 */
const visionQuery = ref('')
const visionNeedle = computed(() => normalizeForSearch(visionQuery.value).trim())
const filteredVisionFiles = computed(() => {
  const needle = visionNeedle.value
  if (!needle) return visionFiles.value
  return visionFiles.value.filter((f) => normalizeForSearch(f.name).includes(needle))
})
const filteredVisionEntries = computed(() => {
  const needle = visionNeedle.value
  if (!needle) return visionEntries.value
  return visionEntries.value.filter((e) => matchesSearch(e, needle, hubProviders.value))
})
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
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/** Context-scoped delete (one path — see removeModel). */
async function removeVision(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('vision', f.name, f.provider, f.diffusionType)
}
function visionDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`vision:${e.url}`]
}
function visionHasEntries(): boolean {
  return [...new Set((appStore.catalog?.entries ?? []).map((e) => e.diffusionType))].some((dt) =>
    (appStore.catalog?.entries ?? []).some((e) => e.type === 'vision' && e.diffusionType === dt)
  )
} 

// ---------- tokenizer ----------
const tokenizerType = ref(diffusionTypes.value[0] ?? '')
const tokenizerFiles = computed(() => settingsStore.modelLists.tokenizer ?? [])
const tokenizerEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'tokenizer' && e.diffusionType === tokenizerType.value)
)
/**
 * Tokenizer-section search filter, mirroring the Models section: normalized
 * (space, '-' and '_' equivalent) + trimmed needle; an empty needle (blank
 * query or separators only) means no filtering. `tokenizerInstalledNames` (the
 * "installed" tag on hub rows) keeps deriving from the unfiltered
 * `tokenizerFiles` so installed tags don't vanish while a query is active;
 * `defaultTokenizer` is keyed by name and unaffected.
 */
const tokenizerQuery = ref('')
const tokenizerNeedle = computed(() => normalizeForSearch(tokenizerQuery.value).trim())
const filteredTokenizerFiles = computed(() => {
  const needle = tokenizerNeedle.value
  if (!needle) return tokenizerFiles.value
  return tokenizerFiles.value.filter((f) => normalizeForSearch(f.name).includes(needle))
})
const filteredTokenizerEntries = computed(() => {
  const needle = tokenizerNeedle.value
  if (!needle) return tokenizerEntries.value
  return tokenizerEntries.value.filter((e) => matchesSearch(e, needle, hubProviders.value))
})
const tokenizerInstalledNames = computed(() => new Set(tokenizerFiles.value.map((f) => f.name)))
const defaultTokenizer = computed(() => settingsStore.settings.defaultTokenizer?.[tokenizerType.value] ?? '')
async function setDefaultTokenizer(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultTokenizer ?? {}) }
  if (name) map[tokenizerType.value] = name
  else delete map[tokenizerType.value]
  await settingsStore.save({ defaultTokenizer: map })
}
async function downloadTokenizer(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('tokenizer', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
/** Context-scoped delete (one path — see removeModel). */
async function removeTokenizer(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('tokenizer', f.name, f.provider, f.diffusionType)
}

// ---------- audio encoder (Wan2.2 S2V wav2vec2) ----------
// The type dropdown lists diffusion types; the entries resolve from the
// REQUIRED family (repo.audio_encoder is keyed by the wan2_2 family and
// reached through `requires.audio_encoder.from`), so picking `wan2_2_s2v`
// surfaces the wav2vec2 entry. Types without a required audio encoder list
// none.
const audioEncoderType = ref(diffusionTypes.value[0] ?? '')
const audioEncoderFiles = computed(() => settingsStore.modelLists.audio_encoder ?? [])
const audioEncoderEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter(
    (e) =>
      e.type === 'audio_encoder' &&
      e.diffusionType === requiredFamilyFor(audioEncoderType.value, 'audio_encoder')
  )
)
const audioEncoderInstalledNames = computed(() => new Set(audioEncoderFiles.value.map((f) => f.name)))
async function downloadAudioEncoder(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('audio_encoder', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
function audioEncoderDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`audio_encoder:${e.url}`]
}
async function removeAudioEncoder(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('audio_encoder', f.name, f.provider, f.diffusionType)
}
// Pre-existing write-side gap fixed (ltx25-support plan §5.10): the Settings
// type carried `defaultAudioEncoder` and the chat panel read it, but no UI
// ever wrote it — the default picker below clones the tokenizer pattern.
const defaultAudioEncoder = computed(() => settingsStore.settings.defaultAudioEncoder?.[audioEncoderType.value] ?? '')
async function setDefaultAudioEncoder(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultAudioEncoder ?? {}) }
  if (name) map[audioEncoderType.value] = name
  else delete map[audioEncoderType.value]
  await settingsStore.save({ defaultAudioEncoder: map })
}

// ---------- audio vae (LTX 2.5 audio track) ----------
// The type dropdown lists diffusion types; the entries resolve from the
// diffusion type DIRECTLY (no `requires` indirection — repo.audio_vae is
// keyed by the family itself). Types without a hub audio VAE list none.
const audioVaeType = ref(diffusionTypes.value[0] ?? '')
const audioVaeFiles = computed(() => settingsStore.modelLists.audio_vae ?? [])
const audioVaeEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === 'audio_vae' && e.diffusionType === audioVaeType.value
  )
)
const audioVaeInstalledNames = computed(() => new Set(audioVaeFiles.value.map((f) => f.name)))
const defaultAudioVae = computed(() => settingsStore.settings.defaultAudioVae?.[audioVaeType.value] ?? '')
async function setDefaultAudioVae(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultAudioVae ?? {}) }
  if (name) map[audioVaeType.value] = name
  else delete map[audioVaeType.value]
  await settingsStore.save({ defaultAudioVae: map })
}
async function downloadAudioVae(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('audio_vae', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
function audioVaeDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`audio_vae:${e.url}`]
}
async function removeAudioVae(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('audio_vae', f.name, f.provider, f.diffusionType)
}

// ---------- latent upscaler (LTX 2.5 hires fix) ----------
// Same shape as the audio VAE section: the entries resolve from the diffusion
// type DIRECTLY (repo.latent_upscaler is keyed by the family itself).
const latentUpscalerType = ref(diffusionTypes.value[0] ?? '')
const latentUpscalerFiles = computed(() => settingsStore.modelLists.latent_upscaler ?? [])
const latentUpscalerEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === 'latent_upscaler' && e.diffusionType === latentUpscalerType.value
  )
)
const latentUpscalerInstalledNames = computed(() => new Set(latentUpscalerFiles.value.map((f) => f.name)))
const defaultLatentUpscaler = computed(() => settingsStore.settings.defaultLatentUpscaler?.[latentUpscalerType.value] ?? '')
async function setDefaultLatentUpscaler(name: string): Promise<void> {
  const map = { ...(settingsStore.settings.defaultLatentUpscaler ?? {}) }
  if (name) map[latentUpscalerType.value] = name
  else delete map[latentUpscalerType.value]
  await settingsStore.save({ defaultLatentUpscaler: map })
}
async function downloadLatentUpscaler(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('latent_upscaler', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}
function latentUpscalerDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`latent_upscaler:${e.url}`]
}
async function removeLatentUpscaler(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('latent_upscaler', f.name, f.provider, f.diffusionType)
}
function tokenizerDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`tokenizer:${e.url}`]
}
function tokenizerHasEntries(): boolean {
  return [...new Set((appStore.catalog?.entries ?? []).map((e) => e.diffusionType))].some((dt) =>
    (appStore.catalog?.entries ?? []).some((e) => e.type === 'tokenizer' && e.diffusionType === dt)
  )
}

// ---------- sampling ----------
const samplingType = ref(diffusionTypes.value[0] ?? '')
const samplingBase = computed<SamplingDefaults | null>(() => appStore.configs?.sampling[samplingType.value] ?? null)
// Pretty-printed, indented JSON for the collapsible "defaults" summary.
const samplingJsonExpanded = ref(false)
function toggleSamplingJson(): void {
  samplingJsonExpanded.value = !samplingJsonExpanded.value
}
const samplingPrettyJson = computed(() => (samplingBase.value ? JSON.stringify(samplingBase.value, null, 2) : '—'))
const samplingOverride = ref<SamplingOverrideValues>({})
function loadOverride(): void {
  samplingOverride.value = { ...(settingsStore.settings.sampling?.[samplingType.value] ?? {}) }
  // Map undefined and null → '' for the placeholder-bound fields so an
  // empty select / empty textarea displays instead of a blank select.
  for (const k of ['sampler', 'scheduler', 'negative'] as const) {
    if (samplingOverride.value[k] == null) samplingOverride.value[k] = ''
  }
}
watch(samplingType, loadOverride)
async function saveSampling(): Promise<void> {
  // Drop empty-string values for the placeholder-bound fields so the merge
  // in effectiveSampling() never spawns `--sampling-method ""` /
  // `--scheduler ""` / `--negative-prompt ""`.
  const o = { ...samplingOverride.value }
  for (const k of ['sampler', 'scheduler', 'negative'] as const) {
    if (typeof o[k] === 'string' && !(o[k] as string).trim()) delete o[k]
  }
  // flow_shift: only a finite number (incl 0) is kept — '' / null / undefined
  // / non-numeric junk deletes the override key so the sampling.json default
  // applies.
  const fs = o.flow_shift
  if (fs !== undefined && !(typeof fs === 'number' && Number.isFinite(fs))) delete o.flow_shift
  samplingOverride.value = o
  const map = { ...(settingsStore.settings.sampling ?? {}) }
  if (Object.keys(samplingOverride.value).length) map[samplingType.value] = samplingOverride.value
  else delete map[samplingType.value]
  // `samplingOverride.value` is a deeply reactive Proxy (Vue ref). A shallow
  // spread leaves the override object as a reactive Proxy, which
  // `ipcRenderer.invoke` cannot structured-clone (it throws "An object could
  // not be cloned", silently dropping the save and the toast). JSON
  // round-trip unwraps every level into a plain, serializable object before
  // it crosses the preload bridge.
  const payload = JSON.parse(JSON.stringify({ sampling: { ...map } }))
  try {
    await settingsStore.save(payload)
    toast('Sampling saved', 'ok')
  } catch (err) {
    toast(`Failed to save sampling overrides: ${(err as Error).message}`, 'error')
  }
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
    // A cancel/pause aborts the runtime download; the store rethrows the
    // DOWNLOAD_ABORTED_MESSAGE error for it — cancelRuntime() already toasted
    // it; not a failure.
    if (!isAbortedDownload(err)) {
      toast(`Runtime download failed: ${(err as Error).message}`, 'error')
    }
  }
}

// ---------- runtime config update check ----------
const runtimeChecking = ref(false)
const runtimeResetting = ref(false)
/** Comma-join versions sorted numerically descending (same order as the versions list). */
function fmtVersions(vs: string[]): string {
  return [...vs].sort((a, b) => Number(b) - Number(a)).map((v) => `v${v}`).join(', ')
}
async function checkRuntimeUpdates(): Promise<void> {
  runtimeChecking.value = true
  try {
    const result = await settingsStore.checkRuntimeUpdates()
    if (result.updated) {
      if (result.newVersions.length) {
        let msg = `Runtime config updated (new: ${fmtVersions(result.newVersions)})`
        if (result.removedVersions.length) {
          msg += ` (removed: ${fmtVersions(result.removedVersions)})`
        }
        toast(msg, 'ok')
      } else {
        // Content-only change (e.g. upstream fixed a download URL).
        toast('Runtime config updated', 'ok')
      }
    } else {
      toast('Runtime is up to date', 'ok')
    }
  } catch (err) {
    toast(`Check failed: ${(err as Error).message}`, 'error')
  } finally {
    runtimeChecking.value = false
  }
}
async function resetRuntimeConfig(): Promise<void> {
  runtimeResetting.value = true
  try {
    await settingsStore.resetRuntimeConfig()
    toast('Runtime config reset to bundled', 'ok')
  } catch (err) {
    toast(`Reset failed: ${(err as Error).message}`, 'error')
  } finally {
    runtimeResetting.value = false
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

// ---------- downloads (control UI) ----------
function entryProgress(e: DownloadEntry): ModelDownloadState | undefined {
  return settingsStore.modelDownloads[`${e.type}:${e.url}`]
}
function canCancelEntry(e: DownloadEntry): boolean {
  if (e.status !== 'downloading') return false
  // Cancel is disabled while the runtime is extracting (fast, temp zips already
  // fully downloaded).
  if (settingsStore.downloadsRuntime?.phase === 'extracting') return false
  return true
}
async function cancelEntry(e: DownloadEntry): Promise<void> {
  try {
    await settingsStore.cancelDownload(e.url)
    toast('Download canceled', 'ok')
  } catch (err) {
    toast(`Cancel failed: ${(err as Error).message}`, 'error')
  }
}
async function retryEntry(e: DownloadEntry): Promise<void> {
  try {
    await settingsStore.downloadModel(e.type, e.url, e.provider)
    toast('Retrying download', 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Retry failed: ${(err as Error).message}`, 'error')
  }
}
async function removeEntry(e: DownloadEntry): Promise<void> {
  const ok = await confirm(`Remove ${e.name} from the download registry?`, {
    confirmLabel: 'Remove',
    cancelLabel: 'Cancel'
  })
  if (!ok) return
  try {
    await settingsStore.cancelDownload(e.url)
    toast('Download removed', 'ok')
  } catch (err) {
    toast(`Remove failed: ${(err as Error).message}`, 'error')
  }
}
async function togglePause(): Promise<void> {
  const next = !settingsStore.downloadsPaused
  try {
    await settingsStore.setPaused(next)
    toast(next ? 'Downloads paused' : 'Downloads resumed', 'ok')
  } catch (err) {
    toast(`Operation failed: ${(err as Error).message}`, 'error')
  }
}
async function cancelRuntime(): Promise<void> {
  const v = settingsStore.downloadsRuntime?.version
  if (!v) return
  try {
    await settingsStore.cancelDownload(v)
    toast('Runtime download canceled', 'ok')
  } catch (err) {
    toast(`Cancel failed: ${(err as Error).message}`, 'error')
  }
}

// ---------- tokens (data/hub-tokens.json) ----------
const tokenEntries = ref<TokenEntry[]>([])
/** Dialog open flag + the entry being edited (null = add mode). */
const tokenDialogOpen = ref(false)
const editingToken = ref<TokenEntry | null>(null)

/** Loaded on section open via the section watcher (read on demand, never polled). */
async function refreshTokens(): Promise<void> {
  try {
    tokenEntries.value = await window.api.tokensList()
  } catch (err) {
    toast(`Failed to load tokens: ${(err as Error).message}`, 'error')
  }
}
function openAddToken(): void {
  editingToken.value = null
  tokenDialogOpen.value = true
}
function openEditToken(e: TokenEntry): void {
  editingToken.value = e
  tokenDialogOpen.value = true
}
function onTokenSaved(): void {
  void refreshTokens()
}
async function deleteTokenEntry(e: TokenEntry): Promise<void> {
  const ok = await confirm(`Delete token entry "${e.key}"?`, {
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel'
  })
  if (!ok) return
  try {
    await window.api.tokensDelete(e.key)
    toast(`Deleted ${e.key}`, 'ok')
    await refreshTokens()
  } catch (err) {
    toast(`Delete failed: ${(err as Error).message}`, 'error')
  }
}
async function importTokensFromFile(): Promise<void> {
  try {
    const res = await window.api.tokensImportFile()
    if (res === null) return // canceled — silent no-op
    toast(`Imported: ${res.added} added, ${res.updated} updated, ${res.skipped} skipped`, 'ok')
    if (res.errors.length) {
      const extra = res.errors.length > 1 ? ` (+${res.errors.length - 1} more)` : ''
      toast(`${res.errors[0]}${extra}`, 'error')
    }
    await refreshTokens()
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`, 'error')
  }
}
async function exportTokensToFile(): Promise<void> {
  try {
    const p = await window.api.tokensExportFile()
    if (p === null) return // canceled — silent no-op
    toast(`Exported to ${p}`, 'ok')
  } catch (err) {
    toast(`Export failed: ${(err as Error).message}`, 'error')
  }
}
/** Pattern-type caption per row (mirrors the dialog's live preview). */
function tokenPatternCaption(e: TokenEntry): string {
  if (e.patternType === 'full-wildcard') {
    return 'Full wildcard (ALL repos — a bad token here affects public downloads too)'
  }
  if (e.patternType === 'partial-wildcard') {
    // Prefix SHAPE (source-agnostic): "org-level" for a single-segment
    // prefix ("org/*") vs "nested" for a multi-segment one ("a/b/*"). On
    // HuggingFace the nested form can never match (repo slugs are exactly
    // org/repo) — a harmless dead entry.
    const shape = e.repoPattern.slice(0, -2).includes('/') ? 'nested' : 'org-level'
    return `Partial wildcard (${shape})`
  }
  return 'Exact match'
}

// ---------- logs ----------
const logsContent = ref('')
const logsSize = ref(0)
const logsRefreshedAt = ref('')
const logsLoading = ref(false)
const logsPre = ref<HTMLElement | null>(null)

/**
 * Read the tail of data/logs/latest.log. Fired via the immediate watcher on
 * `section` below, which covers both dialog mount (no-op unless Logs is the
 * initial section) and every nav activation — the section is read on demand,
 * never polled.
 */
async function refreshLogs(): Promise<void> {
  logsLoading.value = true
  try {
    const info = await window.api.logsGet()
    logsContent.value = info.content
    logsSize.value = info.size
    logsRefreshedAt.value = new Date().toLocaleTimeString()
    // Auto-scroll to the bottom: the newest lines are what matters when
    // diagnosing a failure.
    await nextTick()
    const el = logsPre.value
    if (el) el.scrollTop = el.scrollHeight
  } catch (err) {
    toast(`Failed to read logs: ${(err as Error).message}`, 'error')
  } finally {
    logsLoading.value = false
  }
}
watch(
  section,
  (s) => {
    if (s === 'logs') void refreshLogs()
    if (s === 'tokens') void refreshTokens()
  },
  { immediate: true }
)

// ---------- llm (Language Models + Language Inference) ----------
const llmTypes = computed(() => appStore.configs?.hub.llm_models ?? [])
const llmType = ref('')
// Default the type dropdown to the hub default llm_type, else the first
// configured type (configs load async — react once they arrive).
watch(
  () => llmTypes.value,
  (types) => {
    if (llmType.value || types.length === 0) return
    const def = appStore.configs?.hub.repo?.llm?.default?.llm_type
    llmType.value = def && types.some((t) => t.name === def) ? def : types[0]!.name
  },
  { immediate: true }
)

const llmFiles = computed(() => settingsStore.modelLists.llm ?? [])
const llmEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter((e) => e.type === 'llm' && e.diffusionType === llmType.value)
)
const llmInstalledNames = computed(() => new Set(llmFiles.value.map((f) => baseName(f.name))))
const llmSelected = computed(() => settingsStore.settings.llm?.model ?? null)

function llmRowKey(f: ModelFile): string {
  return `${f.diffusionType ?? ''}/${f.provider ?? ''}/${f.name}`
}

/**
 * Save a patch into settings.llm — the FULL merged object. settings:save
 * merges patches SHALLOWLY (`{ ...current, ...patch }`), so a partial
 * `{ llm: … }` patch would wipe the rest of the block.
 */
async function saveLlm(patch: Partial<LlmSettings>): Promise<void> {
  const current = settingsStore.settings.llm ?? {}
  await settingsStore.save({ llm: { ...current, ...patch } })
}

async function downloadLlm(e: CatalogEntry): Promise<void> {
  try {
    await settingsStore.downloadModel('llm', e.url, e.provider)
    toast(`Downloaded ${e.name}`, 'ok')
  } catch (err) {
    if (!isAbortedDownload(err)) toast(`Download failed: ${(err as Error).message}`, 'error')
  }
}

/** Context-scoped delete (one path — see removeModel). */
async function removeLlm(f: ModelFile): Promise<void> {
  const ok = await confirm(`Delete ${f.name}?`, { confirmLabel: 'Delete', cancelLabel: 'Cancel' })
  if (!ok) return
  await settingsStore.removeModel('llm', f.name, f.provider, f.diffusionType)
}

function llmDlState(e: CatalogEntry) {
  return settingsStore.modelDownloads[`llm:${e.url}`]
}

/** Whether a hub row is the effective default: the explicit settings pick,
 *  or (no pick) the hub-default-stamped entry. */
function isLlmDefault(e: CatalogEntry): boolean {
  const sel = llmSelected.value
  if (sel) return sel.model === e.name && sel.provider === (e.provider ?? 'default')
  return !!e.isDefault
}

/** Set-default toggle: clicking the active selection clears the override
 *  (inherit the hub default); clicking another entry selects it. */
async function setDefaultLlm(e: CatalogEntry): Promise<void> {
  const sel = llmSelected.value
  if (sel && sel.model === e.name && sel.provider === (e.provider ?? 'default')) {
    await saveLlm({ model: undefined })
    toast('Default language model reset to the hub default', 'ok')
    return
  }
  await saveLlm({
    model: { llmType: e.diffusionType, provider: e.provider ?? 'default', model: e.name }
  })
  toast(`Default language model set to ${e.name}`, 'ok')
}

// llama.cpp runtime status row (Install / Re-install + llm:progress).
const llmInstalling = ref(false)
async function installLlmRuntime(): Promise<void> {
  llmInstalling.value = true
  try {
    await settingsStore.installLlmRuntime()
    toast('LLM runtime installed', 'ok')
  } catch (err) {
    toast(`LLM runtime install failed: ${(err as Error).message}`, 'error')
  } finally {
    llmInstalling.value = false
  }
}

// ---------- Language Inference ----------
const llmHubDefault = computed(() => appStore.configs?.hub.repo?.llm?.default)
const llmHubSystemPrompt = computed(
  () => appStore.configs?.hub.repo?.llm?.system_prompts?.['llm'] ?? ''
)

const LLM_CACHE_TYPES = ['f16', 'bf16', 'q8_0', 'q5_1', 'q4_0'] as const

// Editable fields — empty string = inherit the hub default (only non-empty
// fields are written to settings.llm on Save). The dialog is v-if mounted, so
// seeding from the saved settings at setup time runs on every open.
const llmSystemPrompt = ref(settingsStore.settings.llm?.systemPrompt ?? '')
const llmFlash = ref<string>(settingsStore.settings.llm?.flashAttention ?? '')
const llmKCache = ref<string>(settingsStore.settings.llm?.kCache ?? '')
const llmVCache = ref<string>(settingsStore.settings.llm?.vCache ?? '')
const str = (v: number | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const llmContextSize = ref(str(settingsStore.settings.llm?.contextSize))
const llmEvalBatch = ref(str(settingsStore.settings.llm?.evalBatchSize))
const llmChunkBatch = ref(str(settingsStore.settings.llm?.chunkBatchSize))
const llmTemp = ref(str(settingsStore.settings.llm?.temp))
const llmMinP = ref(str(settingsStore.settings.llm?.minP))
const llmTopP = ref(str(settingsStore.settings.llm?.topP))
const llmTopK = ref(str(settingsStore.settings.llm?.topK))
const llmRepeatPenalty = ref(str(settingsStore.settings.llm?.repeatPenalty))

function llmNum(s: string): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** Save the inference overrides: only non-empty fields are written (empty =
 *  inherit the hub default), merged into the FULL settings.llm object. */
async function saveLlmInference(): Promise<void> {
  const patch: Partial<LlmSettings> = {}
  if (llmSystemPrompt.value.trim()) patch.systemPrompt = llmSystemPrompt.value
  if (llmFlash.value === 'on' || llmFlash.value === 'off') patch.flashAttention = llmFlash.value
  if (llmKCache.value) patch.kCache = llmKCache.value
  if (llmVCache.value) patch.vCache = llmVCache.value
  const ctx = llmNum(llmContextSize.value)
  if (ctx !== undefined) patch.contextSize = Math.round(ctx)
  const eb = llmNum(llmEvalBatch.value)
  if (eb !== undefined) patch.evalBatchSize = Math.round(eb)
  const cb = llmNum(llmChunkBatch.value)
  if (cb !== undefined) patch.chunkBatchSize = Math.round(cb)
  const temp = llmNum(llmTemp.value)
  if (temp !== undefined) patch.temp = temp
  const minP = llmNum(llmMinP.value)
  if (minP !== undefined) patch.minP = minP
  const topP = llmNum(llmTopP.value)
  if (topP !== undefined) patch.topP = topP
  const topK = llmNum(llmTopK.value)
  if (topK !== undefined) patch.topK = Math.round(topK)
  const rp = llmNum(llmRepeatPenalty.value)
  if (rp !== undefined) patch.repeatPenalty = rp
  await saveLlm(patch)
  toast('Language inference settings saved', 'ok')
}

/** Clear the system-prompt override so the hub default applies again. */
async function resetLlmSystemPrompt(): Promise<void> {
  llmSystemPrompt.value = ''
  await saveLlm({ systemPrompt: null })
  toast('System prompt reset to the hub default', 'ok')
}

onMounted(async () => {
  await settingsStore.listModels('diffusion')
  await settingsStore.listModels('encoder')
  await settingsStore.listModels('vae')
  await settingsStore.listModels('vision')
  await settingsStore.listModels('tokenizer')
  await settingsStore.listModels('audio_encoder')
  await settingsStore.listModels('audio_vae')
  await settingsStore.listModels('latent_upscaler')
  await settingsStore.listModels('llm')
  void settingsStore.loadLlmStatus()
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
          <section v-if="section === 'release-notes'">
            <h3>Release Notes</h3>
            <div class="release-notes" v-html="releaseNotesHtml"></div>
          </section>
          <section v-if="section === 'models'">
            <div class="section-head">
              <h3>Diffusion models</h3>
              <div class="row">
                <button :disabled="hubChecking" @click="checkHubUpdates()">
                  {{ hubChecking ? 'Checking…' : 'Check' }}
                </button>
                <button :disabled="hubResetting" @click="resetHubConfig()">
                  {{ hubResetting ? 'Resetting…' : 'Reset' }}
                </button>
                <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                  {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
                </button>
              </div>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p> 

            <input
              v-model="modelQuery"
              class="model-search"
              type="text"
              placeholder="Filter models — space, '-' and '_' are equivalent"
            />

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in filteredModelFiles" :key="rowKey(f)" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ f.name }}</span>
                  <span class="faint">{{ fmtBytes(f.size) }}</span>
                  <button
                    class="icon"
                    title="Download dependencies (VAE, text encoder, vision)"
                    @click="downloadDependencies(f)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
                    </svg>
                  </button>
                  <button class="icon danger" title="Delete" @click="removeModel(f)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                    </svg>
                  </button>
                </div>
                <div v-if="rowContext(f)" class="dl-item-desc">{{ rowContext(f) }}</div>
                <div v-if="installedDesc(f.name)" class="dl-item-desc">{{ installedDesc(f.name) }}</div>
              </li>
              <li v-if="!modelFiles.length" class="muted">No models downloaded yet.</li>
              <li v-else-if="!filteredModelFiles.length" class="muted">No installed models match "{{ modelQuery }}"</li>
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
            <div v-for="[provider, entries] in filteredProviderGroups" :key="provider" class="provider-group">
              <h5>{{ provider }}</h5>
              <ul class="file-list">
                <li v-for="e in entries" :key="e.id" class="dl-item">
                  <div class="dl-item-top">
                    <span class="mono">{{ e.name }}</span>
                    <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                    <span
                      v-if="accessBadge(e)"
                      class="auth-tag"
                      :title="accessTitle(e)"
                    >{{ accessBadge(e) }}</span>
                    <span
                      v-else-if="e.source === 'civitai'"
                      class="auth-tag"
                      title="Downloads from CivitAI — requires a CivitAI API token (Settings → Tokens)"
                    >Auth</span>
                    <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                    <template v-if="installedNames.has(baseName(e.name))">
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
                  <div v-if="e.description" class="dl-item-desc">{{ e.description }}</div>
                  <DownloadProgress
                    v-if="dlState(e)"
                    class="grow"
                    :downloaded-bytes="dlState(e)!.downloadedBytes"
                    :total-bytes="dlState(e)!.totalBytes"
                  />
                </li>
              </ul>
            </div>
            <p v-if="!diffusionEntries.length" class="muted">
              No diffusion models in the catalog. Use "Refresh hub" to scan the repositories.
            </p>
            <p v-else-if="!filteredProviderGroups.length" class="muted">
              No models match "{{ modelQuery }}"
            </p>
          </section> 
          <section v-if="section === 'vae'">
            <h3>VAE</h3>
            <label class="muted">Diffusion type</label>
            <select v-model="vaeType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>
            <p class="muted">
              Choose the default VAE used for {{ vaeType }}. Download it from the VAE dropdown in the chat composer.
            </p>
            <input
              v-model="vaeQuery"
              class="model-search"
              type="text"
              placeholder="Filter VAE — space, '-' and '_' are equivalent"
            />
            <ul class="file-list">
              <li v-for="e in filteredVaeEntries" :key="e.id">
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
              <li v-else-if="!filteredVaeEntries.length" class="muted">No VAE entries match "{{ vaeQuery }}"</li>
            </ul>
          </section> 
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

            <input
              v-model="encoderQuery"
              class="model-search"
              type="text"
              placeholder="Filter text encoders — space, '-' and '_' are equivalent"
            />

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in filteredEncoderFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <DownloadProgress
                  v-if="installedDlState('encoder', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('encoder', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('encoder', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeEncoder(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!encoderFiles.length" class="muted">No text encoders downloaded yet.</li>
              <li v-else-if="!filteredEncoderFiles.length" class="muted">No installed text encoders match "{{ encoderQuery }}"</li>
            </ul> 

            <h4>Available from hub</h4>
            <p v-if="encoderIsBundle" class="muted">
              Bundle — the text encoders for this diffusion type download together as one set
              (no per-file default). If the list is empty, refresh the hub to populate it.
            </p>
            <ul class="file-list">
              <li v-for="e in filteredEncoderEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="encoderInstalledNames.has(baseName(e.name))">
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
                    v-if="!encoderIsBundle"
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
              <li v-else-if="!filteredEncoderEntries.length" class="muted">No text encoders match "{{ encoderQuery }}"</li>
            </ul>
          </section> 
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

            <input
              v-model="visionQuery"
              class="model-search"
              type="text"
              placeholder="Filter vision models — space, '-' and '_' are equivalent"
            />

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in filteredVisionFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <DownloadProgress
                  v-if="installedDlState('vision', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('vision', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('vision', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeVision(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!visionFiles.length" class="muted">No vision models downloaded yet.</li>
              <li v-else-if="!filteredVisionFiles.length" class="muted">No installed vision models match "{{ visionQuery }}"</li>
            </ul> 

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in filteredVisionEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="visionInstalledNames.has(baseName(e.name))">
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
              <li v-else-if="!filteredVisionEntries.length" class="muted">No vision models match "{{ visionQuery }}"</li>
            </ul>
          </section>
          <section v-if="section === 'tokenizer' && tokenizerHasEntries()">
            <div class="section-head">
              <h3>Tokenizer</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>

            <p class="muted">
              The tokenizer (tokenizer.json) converts prompts into model tokens. Only present for
              diffusion types that declare a tokenizer dependency.
            </p>

            <label class="muted">Diffusion type</label>
            <select v-model="tokenizerType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>

            <input
              v-model="tokenizerQuery"
              class="model-search"
              type="text"
              placeholder="Filter tokenizers — space, '-' and '_' are equivalent"
            />

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in filteredTokenizerFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <DownloadProgress
                  v-if="installedDlState('tokenizer', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('tokenizer', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('tokenizer', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeTokenizer(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!tokenizerFiles.length" class="muted">No tokenizers downloaded yet.</li>
              <li v-else-if="!filteredTokenizerFiles.length" class="muted">No installed tokenizers match "{{ tokenizerQuery }}"</li>
            </ul>

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in filteredTokenizerEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="tokenizerInstalledNames.has(baseName(e.name))">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="tokenizerDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${tokenizerDlState(e)!.downloadedBytes} / ${tokenizerDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadTokenizer(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultTokenizer === e.name }"
                    @click="setDefaultTokenizer(e.name)"
                  >
                    {{ defaultTokenizer === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="tokenizerDlState(e)"
                  class="grow"
                  :downloaded-bytes="tokenizerDlState(e)!.downloadedBytes"
                  :total-bytes="tokenizerDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!tokenizerEntries.length" class="muted">No tokenizer entries for this diffusion type.</li>
              <li v-else-if="!filteredTokenizerEntries.length" class="muted">No tokenizers match "{{ tokenizerQuery }}"</li>
            </ul>
          </section>
          <section v-if="section === 'audio_encoder' && audioEncoderEntries.length">
            <div class="section-head">
              <h3>Audio Encoder</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>

            <p class="muted">
              The wav2vec2 audio encoder drives Wan2.2 S2V (speech-to-video). Only present for
              diffusion types that require an audio encoder.
            </p>

            <label class="muted">Diffusion type</label>
            <select v-model="audioEncoderType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in audioEncoderFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <button class="icon danger" title="Delete" @click="removeAudioEncoder(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!audioEncoderFiles.length" class="muted">No audio encoders downloaded yet.</li>
            </ul>

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in audioEncoderEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="audioEncoderInstalledNames.has(baseName(e.name))">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="audioEncoderDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${audioEncoderDlState(e)!.downloadedBytes} / ${audioEncoderDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadAudioEncoder(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultAudioEncoder === e.name }"
                    @click="setDefaultAudioEncoder(e.name)"
                  >
                    {{ defaultAudioEncoder === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="audioEncoderDlState(e)"
                  class="grow"
                  :downloaded-bytes="audioEncoderDlState(e)!.downloadedBytes"
                  :total-bytes="audioEncoderDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!audioEncoderEntries.length" class="muted">No audio encoder entries for this diffusion type.</li>
            </ul>
          </section>
          <section v-if="section === 'audio_vae' && audioVaeEntries.length">
            <div class="section-head">
              <h3>Audio VAE</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>

            <p class="muted">
              The audio VAE decodes the generated audio track (LTX 2.5 generates video WITH sound).
              Only present for diffusion types that declare an audio VAE.
            </p>

            <label class="muted">Diffusion type</label>
            <select v-model="audioVaeType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in audioVaeFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <button class="icon danger" title="Delete" @click="removeAudioVae(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!audioVaeFiles.length" class="muted">No audio VAEs downloaded yet.</li>
            </ul>

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in audioVaeEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="audioVaeInstalledNames.has(baseName(e.name))">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="audioVaeDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${audioVaeDlState(e)!.downloadedBytes} / ${audioVaeDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadAudioVae(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultAudioVae === e.name }"
                    @click="setDefaultAudioVae(e.name)"
                  >
                    {{ defaultAudioVae === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="audioVaeDlState(e)"
                  class="grow"
                  :downloaded-bytes="audioVaeDlState(e)!.downloadedBytes"
                  :total-bytes="audioVaeDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!audioVaeEntries.length" class="muted">No audio VAE entries for this diffusion type.</li>
            </ul>
          </section>
          <section v-if="section === 'latent_upscaler' && latentUpscalerEntries.length">
            <div class="section-head">
              <h3>Latent Upscaler</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>

            <p class="muted">
              The latent upscaler drives the highres fix second pass (LTX 2.5 spatial latent
              upscale — with Upscale ticked the output is 2× the selected resolution).
            </p>

            <label class="muted">Diffusion type</label>
            <select v-model="latentUpscalerType">
              <option v-for="t in diffusionTypes" :key="t" :value="t">{{ t }}</option>
            </select>

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in latentUpscalerFiles" :key="rowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <button class="icon danger" title="Delete" @click="removeLatentUpscaler(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!latentUpscalerFiles.length" class="muted">No latent upscalers downloaded yet.</li>
            </ul>

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in latentUpscalerEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="latentUpscalerInstalledNames.has(baseName(e.name))">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="latentUpscalerDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${latentUpscalerDlState(e)!.downloadedBytes} / ${latentUpscalerDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadLatentUpscaler(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: defaultLatentUpscaler === e.name }"
                    @click="setDefaultLatentUpscaler(e.name)"
                  >
                    {{ defaultLatentUpscaler === e.name ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="latentUpscalerDlState(e)"
                  class="grow"
                  :downloaded-bytes="latentUpscalerDlState(e)!.downloadedBytes"
                  :total-bytes="latentUpscalerDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!latentUpscalerEntries.length" class="muted">No latent upscaler entries for this diffusion type.</li>
            </ul>
          </section>
          <section v-if="section === 'lora'">
            <LoraBrowser />
          </section>
          <section v-if="section === 'llm_models'">
            <div class="section-head">
              <h3>Language Models</h3>
              <button :disabled="appStore.catalogScanning" @click="refreshHub()">
                {{ appStore.catalogScanning ? 'Scanning…' : 'Refresh hub' }}
              </button>
            </div>
            <p v-if="appStore.catalogScanning" class="muted">{{ appStore.catalogMessage || 'Scanning model hub…' }}</p>

            <h4>llama.cpp runtime</h4>
            <p class="muted">
              The Enhance button rewrites your prompt through a local language model. The runtime
              downloads once per machine{{ settingsStore.llmStatus?.platformKey ? ` (${settingsStore.llmStatus.platformKey})` : '' }}.
            </p>
            <div class="dl-item-top">
              <span class="mono">{{ settingsStore.llmStatus?.version ?? '—' }}</span>
              <span v-if="settingsStore.llmStatus?.installed" class="ok-tag">installed</span>
              <span v-else-if="!settingsStore.llmStatus?.platformKey" class="faint">no runtime for this platform</span>
              <span v-else class="faint">not installed</span>
              <button
                v-if="settingsStore.llmStatus?.platformKey"
                class="dl-btn"
                :disabled="llmInstalling"
                @click="installLlmRuntime()"
              >
                {{ llmInstalling ? 'Installing…' : settingsStore.llmStatus?.installed ? 'Re-install' : 'Install' }}
              </button>
            </div>
            <DownloadProgress
              v-if="llmInstalling && settingsStore.llmRuntimeProgress"
              class="grow"
              :downloaded-bytes="settingsStore.llmRuntimeProgress.downloadedBytes"
              :total-bytes="settingsStore.llmRuntimeProgress.totalBytes"
            />

            <label class="muted">Model type</label>
            <select v-model="llmType">
              <option v-for="t in llmTypes" :key="t.name" :value="t.name">{{ t.label }}</option>
            </select>

            <h4>Available from hub</h4>
            <ul class="file-list">
              <li v-for="e in llmEntries" :key="e.id" class="dl-item">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span v-if="e.quant" class="quant-tag">{{ e.quant }}</span>
                  <span v-if="e.size" class="faint">{{ fmtBytes(e.size) }}</span>
                  <template v-if="llmInstalledNames.has(baseName(e.name))">
                    <span class="ok-tag">installed</span>
                  </template>
                  <template v-else>
                    <button
                      v-if="llmDlState(e)"
                      class="dl-btn"
                      disabled
                      :title="`${llmDlState(e)!.downloadedBytes} / ${llmDlState(e)!.totalBytes} downloaded`"
                    >
                      Downloading…
                    </button>
                    <button v-else class="dl-btn" @click="downloadLlm(e)">Download</button>
                  </template>
                  <button
                    class="set-default"
                    :class="{ active: isLlmDefault(e) }"
                    @click="setDefaultLlm(e)"
                  >
                    {{ isLlmDefault(e) ? 'Default' : 'Set default' }}
                  </button>
                </div>
                <DownloadProgress
                  v-if="llmDlState(e)"
                  class="grow"
                  :downloaded-bytes="llmDlState(e)!.downloadedBytes"
                  :total-bytes="llmDlState(e)!.totalBytes"
                />
              </li>
              <li v-if="!llmEntries.length" class="muted">No language model entries for this type.</li>
            </ul>

            <h4>Installed</h4>
            <ul class="file-list">
              <li v-for="f in llmFiles" :key="llmRowKey(f)">
                <span class="mono">{{ f.name }}</span>
                <span class="faint">{{ fmtBytes(f.size) }}</span>
                <span v-if="rowContext(f)" class="faint">{{ rowContext(f) }}</span>
                <DownloadProgress
                  v-if="installedDlState('llm', f.name)"
                  class="grow"
                  :downloaded-bytes="installedDlState('llm', f.name)!.downloadedBytes"
                  :total-bytes="installedDlState('llm', f.name)!.totalBytes"
                />
                <button class="icon danger" title="Delete" @click="removeLlm(f)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                </button>
              </li>
              <li v-if="!llmFiles.length" class="muted">No language models downloaded yet.</li>
            </ul>
          </section>
          <section v-if="section === 'llm_inference'">
            <h3>Language Inference</h3>
            <p class="muted">
              Overrides for the prompt enhancer's llama.cpp run. Empty fields inherit the hub default
              ({{ llmHubDefault ? `context ${llmHubDefault.context_size}, temp ${llmHubDefault.temp}` : 'see hub.json' }}).
            </p>

            <label class="muted">System prompt</label>
            <textarea
              v-model="llmSystemPrompt"
              rows="7"
              class="llm-system-prompt"
              :placeholder="llmHubSystemPrompt || 'System prompt for the enhancer'"
            ></textarea>
            <button class="dl-btn" @click="resetLlmSystemPrompt()">Reset to default</button>

            <table class="kv">
              <tbody>
                <tr>
                  <td>Flash attention</td>
                  <td>
                    <select v-model="llmFlash" style="width: 120px">
                      <option value="">(default)</option>
                      <option value="on">on</option>
                      <option value="off">off</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>K cache</td>
                  <td>
                    <select v-model="llmKCache" style="width: 120px">
                      <option value="">(default)</option>
                      <option v-for="t in LLM_CACHE_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>V cache</td>
                  <td>
                    <select v-model="llmVCache" style="width: 120px">
                      <option value="">(default)</option>
                      <option v-for="t in LLM_CACHE_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>Context size</td>
                  <td><input v-model="llmContextSize" type="number" min="256" :placeholder="llmHubDefault ? String(llmHubDefault.context_size) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Eval batch size (-b)</td>
                  <td><input v-model="llmEvalBatch" type="number" min="1" :placeholder="llmHubDefault ? String(llmHubDefault.eval_batch_size) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Chunk batch size (-ub)</td>
                  <td><input v-model="llmChunkBatch" type="number" min="1" :placeholder="llmHubDefault ? String(llmHubDefault.chunk_batch_size) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Temperature</td>
                  <td><input v-model="llmTemp" type="number" step="0.05" min="0" :placeholder="llmHubDefault ? String(llmHubDefault.temp) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Min P</td>
                  <td><input v-model="llmMinP" type="number" step="0.01" min="0" max="1" :placeholder="llmHubDefault ? String(llmHubDefault.min_p) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Top P</td>
                  <td><input v-model="llmTopP" type="number" step="0.01" min="0" max="1" :placeholder="llmHubDefault ? String(llmHubDefault.top_p) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Top K</td>
                  <td><input v-model="llmTopK" type="number" min="1" :placeholder="llmHubDefault ? String(llmHubDefault.top_k) : ''" style="width: 110px" /></td>
                </tr>
                <tr>
                  <td>Repeat penalty</td>
                  <td><input v-model="llmRepeatPenalty" type="number" step="0.01" min="1" :placeholder="llmHubDefault ? String(llmHubDefault.repeat_penalty) : ''" style="width: 110px" /></td>
                </tr>
              </tbody>
            </table>
            <button class="dl-btn" @click="saveLlmInference()">Save</button>
          </section>
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
                  <td>Strength</td>
                  <td><input v-model.number="samplingOverride.strength" type="number" step="0.05" min="0" max="1" style="width: 90px" /></td>
                </tr>
                <tr>
                  <td>Sampler</td>
                  <td>
                    <select v-model="samplingOverride.sampler" style="width: 160px">
                      <option value="">(default)</option>
                      <option v-for="s in SAMPLER_METHODS" :key="s" :value="s">{{ s }}</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>Scheduler</td>
                  <td>
                    <select v-model="samplingOverride.scheduler" style="width: 160px">
                      <option value="">(model-specific)</option>
                      <option v-for="s in SCHEDULERS" :key="s" :value="s">{{ s }}</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td>Flow shift</td>
                  <td>
                    <input v-model.number="samplingOverride.flow_shift" type="number" step="0.1" placeholder="(default)" style="width: 90px" />
                  </td>
                </tr>
                <tr>
                  <td>Upscale</td>
                  <td>
                    <input v-model="samplingOverride.upscale" type="checkbox" />
                    <span class="faint">Highres fix: second upscale+refine pass (output is 2× the selected resolution).</span>
                  </td>
                </tr>
                <tr>
                  <td>Upscaler steps</td>
                  <td>
                    <input v-model.number="samplingOverride.upscaler_steps" type="number" min="0" step="1" placeholder="(default)" style="width: 90px" />
                    <span class="faint">Second-pass steps; empty or 0 reuses the main steps count.</span>
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
                <tr>
                  <td>Negative</td>
                  <td>
                    <textarea v-model="samplingOverride.negative" rows="3" style="width: 320px; max-width: 100%; display: block" placeholder="(default)"></textarea>
                    <small class="faint">Applied to every generation for this diffusion type as --negative-prompt. Sessions can override this per chat.</small>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="faint">
              Defaults from sampling.json:
              <button
                class="faint-link"
                type="button"
                @click="toggleSamplingJson()"
              >
                {{ samplingJsonExpanded ? '▾' : '▸' }} {{ samplingBase ? 'show JSON' : '—' }}
              </button>
            </p>
            <pre v-if="samplingJsonExpanded && samplingBase" class="faint-json">{{ samplingPrettyJson }}</pre>
            <div class="row">
              <button class="primary" @click="saveSampling()">Save overrides</button>
              <button @click="resetSampling()">Reset to defaults</button>
            </div>
          </section> 
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
                      <option value="custom">Custom</option>
                    </select>
                    <input
                      v-if="perf.flashAttention === 'custom'"
                      v-model="perf.flashAttentionCustom"
                      type="text"
                      placeholder="flash-attn value"
                      style="width: 160px"
                    />
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
          <section v-if="section === 'runtime'">
            <div class="section-head">
              <h3>Runtime</h3>
              <div class="row">
                <button :disabled="runtimeChecking" @click="checkRuntimeUpdates()">
                  {{ runtimeChecking ? 'Checking…' : 'Check' }}
                </button>
                <button :disabled="runtimeResetting" @click="resetRuntimeConfig()">
                  {{ runtimeResetting ? 'Resetting…' : 'Reset' }}
                </button>
              </div>
            </div>
            <table class="kv">
              <tbody>
                <tr><td>Detected OS</td><td>{{ platform?.os ?? '—' }}</td></tr>
                <tr><td>Detected GPU</td><td>{{ platform?.gpu ?? '—' }}<template v-if="platform?.gpuDetail"> ({{ platform.gpuDetail }})</template></td></tr>
                <tr><td>Recommended runtime</td><td class="mono">{{ recommendedKey }}</td></tr>
              </tbody>
            </table> 

            <h4>Versions</h4>
            <ul class="file-list">
              <li
                v-for="v in settingsStore.runtimeVersions"
                :key="v.version"
                :class="{ 'dl-item': settingsStore.runtimeDownloading?.version === v.version }"
              >
                <template v-if="settingsStore.runtimeDownloading?.version === v.version">
                  <div class="dl-item-top">
                    <span class="mono">v{{ v.version }}</span>
                    <span v-if="v.installed" class="ok-tag">installed</span>
                    <span v-else class="faint">not installed</span>
                    <button
                      class="set-default"
                      :class="{ active: selectedVersion === v.version }"
                      :disabled="!v.installed"
                      @click="selectVersion(v.version)"
                    >
                      {{ selectedVersion === v.version ? 'Selected' : 'Select' }}
                    </button>
                  </div>
                  <DownloadProgress
                    class="grow"
                    :downloaded-bytes="settingsStore.runtimeDownloading!.downloadedBytes"
                    :total-bytes="settingsStore.runtimeDownloading!.totalBytes"
                    :phase="settingsStore.runtimeDownloading!.phase"
                  />
                </template>
                <template v-else>
                  <span class="mono">v{{ v.version }}</span>
                  <span v-if="v.installed" class="ok-tag">installed</span>
                  <span v-else class="faint">not installed</span>
                  <button
                    v-if="!v.installed"
                    class="dl-btn"
                    :disabled="settingsStore.downloadsPaused"
                    :title="settingsStore.downloadsPaused ? 'Downloads are paused' : undefined"
                    @click="downloadRuntime(v.version)"
                  >
                    Download
                  </button>
                  <button
                    class="set-default"
                    :class="{ active: selectedVersion === v.version }"
                    :disabled="!v.installed"
                    @click="selectVersion(v.version)"
                  >
                    {{ selectedVersion === v.version ? 'Selected' : 'Select' }}
                  </button>
                </template>
              </li>
            </ul>
            <p class="faint">
              The selected runtime is used for generation. Downloads are stored under
              <span class="mono">{{ 'data/runtime/<version>/' }}</span>.
            </p>
          </section>
          <section v-if="section === 'downloads'">
            <div class="section-head">
              <h3>Downloads</h3>
              <button
                class="dl-btn"
                :class="{ active: settingsStore.downloadsPaused }"
                @click="togglePause()"
              >
                {{ settingsStore.downloadsPaused ? 'Resume all' : 'Pause all downloads' }}
              </button>
            </div>
            <p class="faint">
              Model downloads are staged in <span class="mono">{{ 'data/tmp/' }}</span> and moved into
              place after a full, size-verified fetch. Background retries resume on launch.
            </p>
            <template v-if="settingsStore.downloadsRuntime && settingsStore.downloadsRuntime.version">
              <ul class="file-list">
                <li class="dl-entry">
                  <div class="dl-item-top">
                    <span class="mono">Runtime</span>
                    <span class="mono small faint">v{{ settingsStore.downloadsRuntime.version }}</span>
                    <span v-if="settingsStore.downloadsRuntime.installed" class="ok-tag">installed</span>
                    <span v-else-if="settingsStore.downloadsRuntime.downloading" class="status-tag status-downloading">
                      {{ settingsStore.downloadsRuntime.phase === 'extracting' ? 'extracting' : 'downloading' }}
                    </span>
                  </div>
                  <DownloadProgress
                    v-if="settingsStore.runtimeDownloading?.version === settingsStore.downloadsRuntime.version"
                    class="grow"
                    :downloaded-bytes="settingsStore.runtimeDownloading!.downloadedBytes"
                    :total-bytes="settingsStore.runtimeDownloading!.totalBytes"
                    :phase="settingsStore.runtimeDownloading!.phase"
                  />
                  <button
                    v-if="settingsStore.downloadsRuntime.downloading && settingsStore.runtimeDownloading?.version === settingsStore.downloadsRuntime.version"
                    class="dl-btn danger"
                    :disabled="settingsStore.runtimeDownloading?.phase === 'extracting'"
                    :title="settingsStore.runtimeDownloading?.phase === 'extracting' ? 'Extraction in progress' : 'Cancel runtime download'"
                    @click="cancelRuntime()"
                  >
                    {{ settingsStore.runtimeDownloading?.phase === 'extracting' ? 'Extracting…' : 'Cancel' }}
                  </button>
                </li>
              </ul>
            </template>

            <h4>Model downloads</h4>
            <ul class="file-list">
              <li v-for="e in settingsStore.pendingDownloads" :key="e.url" class="dl-entry">
                <div class="dl-item-top">
                  <span class="mono">{{ e.name }}</span>
                  <span class="faint mono small">({{ e.type }} · {{ e.provider }})</span>
                  <span class="status-tag" :class="'status-' + e.status">{{ e.status }}</span>
                </div>
                <DownloadProgress
                  v-if="e.status === 'downloading'"
                  class="grow"
                  :downloaded-bytes="entryProgress(e)?.downloadedBytes ?? 0"
                  :total-bytes="entryProgress(e)?.totalBytes ?? 0"
                />
                <span v-else-if="e.status === 'failed'" class="faint err">{{ e.error }}</span>
                <div class="row">
                  <button
                    v-if="e.status === 'downloading'"
                    class="dl-btn danger"
                    :disabled="!canCancelEntry(e)"
                    @click="cancelEntry(e)"
                  >
                    Cancel
                  </button>
                  <button
                    v-if="e.status === 'pending' || e.status === 'failed'"
                    class="dl-btn"
                    :disabled="settingsStore.downloadsPaused"
                    @click="retryEntry(e)"
                  >
                    {{ e.status === 'pending' ? 'Retry now' : 'Retry now' }}
                  </button>
                  <button class="dl-btn danger" @click="removeEntry(e)">Remove</button>
                </div>
              </li>
              <li v-if="!settingsStore.pendingDownloads.length" class="faint">
                No model downloads recorded.
              </li>
            </ul>
          </section>
          <section v-if="section === 'tokens'">
            <div class="section-head">
              <h3>Tokens</h3>
            </div>
            <p class="faint">
              Per-source auth tokens for private repos, stored in
              <span class="mono">data/hub-tokens.json</span> keyed
              <span class="mono">{{ '<source>:<repo>' }}</span>. A trailing
              <span class="mono">*</span> is a wildcard:
              <span class="mono">org/*</span> covers every repo of an org,
              <span class="mono">*</span> covers every repo of the source.
            </p>

            <h4>Token entries</h4>
            <ul class="file-list">
              <li v-for="e in tokenEntries" :key="e.key" class="token-entry">
                <div class="dl-item-top">
                  <span class="mono" :title="e.key">{{ e.key }}</span>
                  <span class="mono token-masked">{{ e.maskedToken }}</span>
                  <button class="dl-btn" @click="openEditToken(e)">Edit</button>
                  <button class="dl-btn danger" @click="deleteTokenEntry(e)">Delete</button>
                </div>
                <div class="token-sub faint">{{ tokenPatternCaption(e) }}</div>
              </li>
              <li v-if="!tokenEntries.length" class="faint">
                No token entries. Add one to authenticate private repo downloads.
              </li>
            </ul>

            <div class="row">
              <button class="dl-btn" @click="openAddToken()">+ Add Token Entry</button>
              <button class="dl-btn" @click="importTokensFromFile()">Import</button>
              <button class="dl-btn" @click="exportTokensToFile()">Export</button>
            </div>

            <TokenEntryDialog
              v-if="tokenDialogOpen"
              :entry="editingToken"
              @close="tokenDialogOpen = false"
              @saved="onTokenSaved"
            />
          </section>
          <section v-if="section === 'appearance'">
            <h3>Theme</h3>
            <table class="kv">
              <tbody>
                <tr>
                  <td>Theme</td>
                  <td>
                    <select v-model="settingsStore.theme" @change="onThemeChange">
                      <option v-for="t in listThemes()" :key="t.key" :value="t.key">{{ t.label }}</option>
                    </select>
                    <span class="faint">Apply a theme to the app appearance.</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
          <section v-if="section === 'logs'">
            <div class="section-head">
              <h3>Logs</h3>
              <button class="dl-btn" :disabled="logsLoading" @click="refreshLogs()">Refresh</button>
            </div>
            <p class="faint">
              <span class="mono">data/logs/latest.log</span> · {{ fmtBytes(logsSize) }} ·
              refreshed {{ logsRefreshedAt || '—' }}
            </p>
            <pre v-if="logsContent" ref="logsPre" class="logs-pre">{{ logsContent }}</pre>
            <p v-else class="faint">No log activity yet.</p>
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
  width: 180px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Scroll the section list when the dialog is too short to show every
     entry (stretched to .dialog-body's height, which is already clamped
     by .dialog's fixed height + overflow: hidden). */
  overflow-y: auto;
  min-height: 0;
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
/* Models-section filter input. .dialog-content is a stretch flex column, so
   the input is already full-width — spacing only. */
.model-search {
  margin-bottom: 10px;
}
/* Language Inference system-prompt textarea — full-width, theme-styled. */
.llm-system-prompt {
  width: 100%;
  max-width: 100%;
  display: block;
  margin-bottom: 8px;
  resize: vertical;
  background: var(--bg-panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  font: inherit;
}
.llm-system-prompt:focus {
  outline: none;
  border-color: var(--accent, var(--border));
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
/* Auth/access marker: same tag shape as .quant-tag but in the accent color
   so it draws the eye. Covers BOTH the CivitAI source badge and the hub.json
   `access` badge ('Auth' / 'Gated'). Hover for where to configure the token. */
.auth-tag {
  font-size: 11px;
  color: var(--accent);
  background: var(--bg-panel);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  white-space: nowrap;
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
.release-notes :deep(h2) {
  margin-top: 24px;
  font-size: 16px;
}
.release-notes :deep(h2:first-of-type) {
  margin-top: 0;
}
.release-notes :deep(h3) {
  margin-top: 16px;
  font-size: 14px;
}
.release-notes :deep(p) {
  margin: 8px 0;
}
.release-notes :deep(ul) {
  margin: 8px 0;
  padding-left: 20px;
}
.release-notes :deep(li) {
  margin: 6px 0;
}
.release-notes :deep(strong) {
  color: var(--text);
}
.release-notes :deep(code) {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
}
.release-notes :deep(pre) {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12px;
}
.release-notes :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
.release-notes :deep(a) {
  color: var(--accent);
}
.release-notes :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
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
  min-width: 0;
}
.dl-entry {
  flex-direction: column;
  align-items: stretch;
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
/* Hub description line under the model name (Installed + Available lists). */
.dl-item-desc {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
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
.dl-btn.danger {
  color: var(--danger);
}
.dl-btn.danger:hover {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.status-tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--radius-sm);
  text-transform: capitalize;
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.status-tag.status-downloading {
  color: var(--accent);
  border-color: var(--accent);
}
.status-tag.status-failed {
  color: var(--danger);
  border-color: var(--danger);
}
.dl-entry .row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.dl-entry .row button {
  flex-shrink: 0;
}
.dl-entry .faint.err {
  color: var(--danger);
}
.faint-link {
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0 4px;
  font: inherit;
  vertical-align: baseline;
}
.faint-link:hover {
  color: var(--accent);
}
.faint-json {
  margin: 4px 0 0;
  padding: 8px 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  white-space: pre;
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
.logs-pre {
  max-height: 420px;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

/* Tokens section */
.token-entry {
  flex-direction: column;
  align-items: stretch;
}
/* .dl-item-top .mono gives every mono span flex: 1; the masked token must
   stay compact (the key takes the remaining width, ellipsized). Same
   specificity as .dl-item-top .mono — later rule wins. */
.token-entry .token-masked {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.token-sub {
  font-size: 12px;
}
</style>
