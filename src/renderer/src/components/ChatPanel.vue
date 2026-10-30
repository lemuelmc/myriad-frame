<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  CatalogEntry,
  GenerationRequest,
  ModelType,
  ResolutionEntry,
  SessionInputs,
  SessionSamplingOverride
} from '@shared/types'
import { DOWNLOAD_ABORTED_MESSAGE, DEFAULT_SAMPLER } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore, type ModelDownloadState } from '../stores/settings'
import { resolveEncoderBundle, type EncoderBundleEntry } from '../deps'
import { toast } from '../toast'
import { saveImageAs } from '../saveImage'
import ImageFromPath from './ImageFromPath.vue'
import DownloadProgress from './DownloadProgress.vue'
import ModelPickerDialog from './ModelPickerDialog.vue'
import NegativePromptDialog from './NegativePromptDialog.vue'
import SessionSamplingDialog from './SessionSamplingDialog.vue'
import logoTiny from '../../../assets/logo-square-tiny.png'

const appStore = useAppStore()
const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()

// ---------- composer state ----------
const prompt = ref('')
const modelEntry = ref<CatalogEntry | null>(null)
const vaeEntry = ref<CatalogEntry | null>(null)
const encoderEntry = ref<CatalogEntry | null>(null)
// SD3.5-style encoder bundle (`defaults[]`): non-empty for bundle diffusion
// types, in which case `encoderEntry` stays null and the bundle wins.
const encoderBundle = ref<EncoderBundleEntry[]>([])
const visionEntry = ref<CatalogEntry | null>(null)
const resolution = ref<ResolutionEntry | null>(null)
const refImages = ref<string[]>([])
const usePrevious = ref(true)
const busy = ref(false)
// True while a drag is hovering over the textarea, for the drop highlight.
const dragActive = ref(false)
const progress = ref<{ step: number; total: number } | null>(null)
// Optimistic prompt shown locally the instant Send is clicked, before the main
// process persists the messages and streams the first progress event.
const pendingPrompt = ref<string | null>(null)
const pendingRefs = ref<string[]>([])
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
// Model picker dialog (replaces the old composer model <select>).
const pickerOpen = ref(false)
// Negative-prompt + sampling-override dialogs.
const negOpen = ref(false)
const samplingOpen = ref(false)

// ---------- per-session composer input persistence ----------
// The one-shot saved resolution the model watcher consumes after computing
// the resolution list — it doubles as the "a restore is in flight" gate for
// the resolution watchers (both skip while it is set).
const pendingRestoreResolution = ref<ResolutionEntry | null>(null)
// Session id whose saved inputs were last applied (restore de-dup). Plain
// bookkeeping — never rendered, so it needs no reactivity.
let appliedForId: string | null = null
// The saved model could not be resolved because the catalog was not loaded
// yet — the restore re-applies once the catalog arrives.
let restoreUnresolved = false
// Coalescing patches keyed by the session they were made in. Per-session keys
// are required: a single `{ id, patch }` slot would lose session A's pick
// when session B is picked 100 ms later inside the debounce window.
const pendingInputs = new Map<string, SessionInputs>()
let persistTimer: ReturnType<typeof setTimeout> | null = null

/** Resolution identity — width+height, matching how restores match entries. */
function sameResolution(
  a: ResolutionEntry | null | undefined,
  b: ResolutionEntry | null | undefined
): boolean {
  if (!a || !b) return a === b
  return a.width === b.width && a.height === b.height
}

/**
 * Coalesce a composer-input patch for `sessionId` and schedule the debounced
 * persist. The id is captured at schedule time so a session switch inside the
 * debounce window can never land a patch on the wrong session, and per-session
 * entries mean a switch plus a pick elsewhere coexist instead of overwriting.
 * No-op on a null id (no active session — possible after deleting the last
 * one; the picker button is not disabled for that state).
 */
function persistInputs(sessionId: string | null, patch: SessionInputs): void {
  if (!sessionId) return
  const merged: SessionInputs = { ...(pendingInputs.get(sessionId) ?? {}) }
  if (patch.model !== undefined) merged.model = patch.model
  if (patch.diffusionType !== undefined) merged.diffusionType = patch.diffusionType
  if (patch.resolution) {
    // Copy into a plain object: `resolution` holds entries straight from the
    // Pinia-reactive configs (Vue Proxies), and structured clone — what
    // ipcRenderer.invoke uses — throws DataCloneError on Proxies, which the
    // flush's catch would otherwise swallow as a silent total write failure.
    const r = patch.resolution
    merged.resolution = { name: r.name, width: r.width, height: r.height }
  }
  pendingInputs.set(sessionId, merged)
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPendingInputs, 300)
}

/**
 * Flush every pending per-session patch to its own captured id. Each flush is
 * skipped when the captured session no longer exists in the store or when the
 * session's saved `inputs` merged with the pending patch is unchanged per key —
 * the no-op check compares the effective merged result against the saved
 * inputs, never the raw partial patch object (a re-pick of the already-saved
 * model produces a partial patch that only compares equal per key), so
 * restores are write-free and re-picks are true no-ops. Fire-and-forget: the
 * captured session can still vanish between the existence check and the
 * invoke (Sidebar delete, corrupt session file — the service's `read()`
 * returns null and `setInputs` throws like the other mutators), so the catch
 * swallows that expected rejection — but logs it, since a fully silent catch
 * would also hide real persistence failures (it did: a reactive Proxy in the
 * patch made structured clone reject with DataCloneError and nothing was
 * ever written).
 */
function flushPendingInputs(): void {
  persistTimer = null
  for (const [id, patch] of pendingInputs) {
    pendingInputs.delete(id)
    const session = sessionsStore.sessions.find((x) => x.id === id)
    if (!session) continue
    const saved = session.inputs ?? {}
    const effective: SessionInputs = { ...saved }
    if (patch.model !== undefined) effective.model = patch.model
    if (patch.diffusionType !== undefined) effective.diffusionType = patch.diffusionType
    if (patch.resolution !== undefined) effective.resolution = patch.resolution
    const changed =
      (effective.model ?? undefined) !== (saved.model ?? undefined) ||
      (effective.diffusionType ?? undefined) !== (saved.diffusionType ?? undefined) ||
      !sameResolution(effective.resolution, saved.resolution)
    if (!changed) continue
    sessionsStore.setInputs(id, patch).catch((err) => {
      console.warn(`[sessions] persisting inputs for session ${id} failed:`, (err as Error)?.message ?? err)
    })
  }
}

const diffusionType = computed(() => modelEntry.value?.diffusionType ?? '')
const resolutions = computed<ResolutionEntry[]>(() =>
  appStore.resolutionsFor(diffusionType.value)
)
const sampling = computed(() => {
  const base = appStore.configs?.sampling[diffusionType.value]
  if (!base) return null
  return settingsStore.samplingFor(diffusionType.value, base)
})
// Per-session negative prompt (empty ⇒ inherit the global default).
const sessionNegative = computed(() => sessionsStore.active?.inputs?.negativePrompt ?? '')
// Sampling for this session: session override wins over the global default.
// Because `sampling` is the source for both the request fields and the
// summary, session overrides flow everywhere automatically.
const sessionSampling = computed(() => {
  const base = appStore.configs?.sampling[diffusionType.value]
  if (!base) return null
  const global = settingsStore.samplingFor(diffusionType.value, base)
  const so = sessionsStore.active?.inputs?.sampling
  return so ? { ...global, ...so } : global
})
const maxRef = computed(() => sampling.value?.max_reference ?? 0)
const refsEnabled = computed(() => maxRef.value > 0)
// 'Use previous image' is offered only for diffusion types whose sampling
// config allows reference images at all (configurations/sampling.json).
const allowRef = computed(() => sampling.value?.allow_reference === true)
// 'allow_reference' false ⇒ the checkbox is hidden; reset its state so a
// stale checked value never leaks into a request for a diffusion type
// that forbids reference images.
watch(allowRef, (allowed) => {
  if (!allowed) usePrevious.value = false
})

// selected model label shown in the model chip
const modelLabel = computed(() => {
  const e = modelEntry.value
  if (!e) return 'Select model'
  const parts = [e.label || e.name]
  if (e.quant) parts.push(e.quant)
  return parts.join(' · ')
})

// Model picker dialog selection: assigns the entry and closes the dialog.
// The modelEntry watcher handles dependency auto-pick + background downloads;
// re-selecting the already-selected entry assigns an identical reference, so
// the watcher does not fire and the dialog simply closes.
function onPick(e: CatalogEntry): void {
  modelEntry.value = e
  // A user pick supersedes any pending restore resolution.
  pendingRestoreResolution.value = null
  pickerOpen.value = false
  // Remember the pick for the active session (null id no-ops inside
  // persistInputs).
  persistInputs(sessionsStore.activeId, { model: e.name, diffusionType: e.diffusionType })
}

const installedModels = ref<Record<ModelType, Set<string>>>({} as never)
async function refreshInstalled(): Promise<void> {
  for (const t of ['diffusion', 'encoder', 'vae', 'vision'] as ModelType[]) {
    const files = await window.api.modelsList(t)
    installedModels[t] = new Set(files.map((f) => f.name))
  }
}
function isInstalled(e: CatalogEntry): boolean {
  return installedModels[e.type]?.has(e.name) ?? false
}
const prevPendingUrls = ref<string[]>([])
watch(
  () => settingsStore.pendingDownloads.map((e) => e.url),
  (newUrls) => {
    const prev = new Set(prevPendingUrls.value)
    prevPendingUrls.value = newUrls
    for (const u of newUrls) {
      if (!prev.has(u)) {
        void refreshInstalled()
        break
      }
    }
  }
)
// in-flight background dependency downloads, keyed by `${type}:${url}`
const inflight = new Map<string, Promise<void>>()
/**
 * Ensure a catalog entry is on disk. No-op when already installed; otherwise
 * starts (or re-joins) a background download and resolves when it completes.
 */
async function ensureDownloaded(e: CatalogEntry): Promise<void> {
  if (isInstalled(e)) {
    // The file may be a truncated/corrupted download — verify its size
    // against the server before trusting it.
    const v = await window.api.modelsVerify(e.type, e.name, e.url)
    if (!v.ok) {
      toast(
        `${e.name} is incomplete (${v.actual} of ${v.expected} bytes) — re-downloading`,
        'info',
        8000
      )
      await settingsStore.removeModel(e.type, e.name)
    } else {
      return
    }
  }
  const key = `${e.type}:${e.url}`
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      try {
        await settingsStore.downloadModel(e.type, e.url, e.provider)
        await refreshInstalled()
        toast(`Downloaded ${e.name}`, 'ok')
      } catch (err) {
        // Deliberate cancel (Downloads section / Pause) — already toasted by
        // the canceling action; not a failure. Still rethrow for awaiters.
        if ((err as Error).message !== DOWNLOAD_ABORTED_MESSAGE) {
          toast(`Download failed: ${(err as Error).message}`, 'error')
        }
        throw err
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
  }
  await p
}

// All in-flight model downloads (not just the selected entry's), so background
// retries are covered too. Labels are derived by looking up the catalog entry
// whose URL matches; when none matches (e.g. a manual Settings download of a
// URL not in the cached catalog) we fall back to a type-only label.
function downloadLabel(type: ModelType, url: string): string {
  const e = (appStore.catalog?.entries ?? []).find((x) => x.type === type && x.url === url)
  if (e) return `Downloading ${e.type === 'diffusion' ? 'model' : e.type} · ${e.label || e.name}`
  const base = new URL(url).pathname.split('/').pop() ?? url
  return `Downloading ${type} · ${base}`
}
const depDownloads = computed<{ key: string; label: string; state: ModelDownloadState }[]>(() => {
  const out: { key: string; label: string; state: ModelDownloadState }[] = []
  for (const [key, s] of Object.entries(settingsStore.modelDownloads)) {
    out.push({ key, label: downloadLabel(s.type, s.url), state: s })
  }
  return out
})

// when the model changes, pick sensible defaults for vae / encoder / resolution
// and kick off background downloads. Watching the entry itself (not just the
// diffusionType) ensures switching between quantizations of the same family
// also triggers a download of the newly selected model.
watch(
  () => modelEntry.value,
  async (entry) => {
    const dt = entry?.diffusionType
    if (!dt) {
      vaeEntry.value = null
      encoderEntry.value = null
      encoderBundle.value = []
      visionEntry.value = null
      resolution.value = null
      return
    }
    const st = await window.api.settingsGet()
    // Re-entrancy token: restore triggers this watcher on every session
    // switch, so two overlapping async runs — rapid A→B→C switching — could
    // otherwise interleave their post-await assignments and cross-write one
    // session's derived state into another. Bail when the selection changed
    // across the await; a newer run owns the composer now. (Pre-existing
    // race, previously near-impossible to hit by hand; restore makes it
    // reachable.)
    if (modelEntry.value !== entry) return
    const vaeName = st.defaultVae?.[dt]
    // The VAE configured for the diffusion_type (from hub.json) is the source of truth
    const vaeCfg = appStore.configs?.hub.repo.vae[dt]
    const defaultVaeName =
      typeof vaeCfg === 'string'
        ? vaeCfg.split('/').pop() ?? vaeCfg
        : (vaeCfg?.default.split('/').pop() ?? vaeCfg?.default ?? '')
    vaeEntry.value =
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === dt && e.name === vaeName) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === dt && e.name === defaultVaeName) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === dt && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === dt) ??
      null
    // Encoder bundle (SD3.5-style `defaults[]`) — the bundle check must run
    // BEFORE the single-file resolution chain: after a rescan the catalog
    // carries `isDefault` bundle entries, so if the chain ran first its
    // `isDefault` fallback would resolve `encoderEntry` to the first bundle
    // file (clip_g) and the legacy flow would send `--llm clip_g.safetensors`.
    // Assignment (not conditional clearing) covers bundle→single,
    // single→bundle, bundle→bundle and model-deselection without enumerating
    // transitions, so a stale bundle can never leak across model switches.
    const bundle = resolveEncoderBundle(dt)
    encoderBundle.value = bundle
    if (bundle.length) {
      encoderEntry.value = null
    } else {
      // Resolution order: user-configured default (settings) > hub.json
      // `default` (a repo-relative path — match catalog entries by file name
      // so a stale cached catalog without isDefault flags still resolves
      // correctly).
      const userEncoderName = st.defaultEncoder?.[dt]
      const defaultEncoder = appStore.configs?.hub.repo.encoder[dt]?.default ?? ''
      const defaultEncoderName = defaultEncoder.split('/').pop() ?? defaultEncoder
      encoderEntry.value =
        (userEncoderName
          ? (appStore.catalog?.entries ?? []).find(
              (e) => e.type === 'encoder' && e.diffusionType === dt && e.name === userEncoderName
            )
          : undefined) ??
        (appStore.catalog?.entries ?? []).find(
          (e) => e.type === 'encoder' && e.diffusionType === dt && (e.name === defaultEncoder || e.name === defaultEncoderName)
        ) ??
        (appStore.catalog?.entries ?? []).find((e) => e.type === 'encoder' && e.diffusionType === dt && e.isDefault) ??
        (appStore.catalog?.entries ?? []).find((e) => e.type === 'encoder' && e.diffusionType === dt) ??
        null
    }
    // Vision (mmproj) model — only present for diffusion_types that declare a
    // `vision` dependency in hub.json (e.g. qwen_image_2.1).
    const userVisionName = st.defaultVision?.[dt]
    // `vision` is optional in HubConfig — absent when the diffusion type declares no vision dependency.
    const defaultVision = appStore.configs?.hub.repo.vision?.[dt]?.default ?? ''
    const defaultVisionName = defaultVision.split('/').pop() ?? defaultVision
    visionEntry.value =
      (userVisionName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'vision' && e.diffusionType === dt && e.name === userVisionName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'vision' && e.diffusionType === dt && (e.name === defaultVision || e.name === defaultVisionName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vision' && e.diffusionType === dt && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vision' && e.diffusionType === dt) ??
      null
    // Restore support: when a saved resolution is pending, prefer it —
    // matched against the new list by width+height — over the first entry,
    // then clear the one-shot marker so the resolution watchers resume
    // normal operation. This relies on this watcher being registered before
    // the `resolutions` watcher so the restored resolution survives the list
    // guard (which skips while the marker is set) — keep that order.
    const saved = pendingRestoreResolution.value
    resolution.value =
      (saved && resolutions.value.find((x) => x.width === saved.width && x.height === saved.height)) ||
      resolutions.value[0] ||
      null
    pendingRestoreResolution.value = null
    // Auto-download the selected diffusion model and its VAE / text encoder /
    // vision dependencies in the background. Swallow rejections (a paused or
    // canceled download rejects) so a background attempt never becomes an
    // unhandled promise rejection — the error toast already surfaces it.
    if (modelEntry.value) void ensureDownloaded(modelEntry.value).catch(() => {})
    if (vaeEntry.value) void ensureDownloaded(vaeEntry.value).catch(() => {})
    if (encoderEntry.value) void ensureDownloaded(encoderEntry.value).catch(() => {})
    // each bundle file gets its own progress row for free (`depDownloads`
    // keys by `${type}:${url}`)
    for (const e of encoderBundle.value) void ensureDownloaded(e).catch(() => {})
    if (visionEntry.value) void ensureDownloaded(visionEntry.value).catch(() => {})
  },
  { immediate: true }
)

watch(resolutions, (r) => {
  // Skip while a restore is in flight: this guard runs in the same flush as
  // the model watcher but before its post-await continuation, so during a
  // restore it would snap `resolution` to the first entry of the new
  // diffusion type's list before the saved resolution is applied — and that
  // intermediate value would flow into the resolution persist watch and
  // overwrite the session's saved resolution. With the skip, the model
  // watcher alone decides the restored value (saved entry when listed, first
  // entry otherwise), which also removes the visible resolution flicker.
  if (pendingRestoreResolution.value) return
  if (r.length && (!resolution.value || !r.some((x) => x.width === resolution.value!.width && x.height === resolution.value!.height))) {
    resolution.value = r[0]
  }
})

// Persist the selected resolution for the active session. Skipped while a
// restore is in flight — during one, the model watcher has not applied the
// saved resolution yet and the `watch(resolutions)` guard can assign an
// intermediate first-entry value in that window; persisting it would
// overwrite the session's saved resolution. Outside that window the watch
// schedules unconditionally — never compared against the session's saved
// value here, because a schedule-side comparison against the saved (disk)
// value loses to a pending stale patch on a quick round-trip (R1 → R2 → R1
// inside one debounce window schedules nothing on the second hop while the
// still-pending R2 flushes, persisting R2 while the composer shows R1).
// Always-scheduling keeps the pending patch a faithful mirror of the
// composer, which makes restores write-free and quick reverts true no-ops —
// the flush-time equality check is the only no-op gate. The model watcher's
// user-initiated resolution reset flows through here too, so the reset value
// is what gets persisted — correct, since the composer shows it. A `null`
// resolution (blank/cleared composer) is never persisted.
watch(resolution, (r) => {
  if (pendingRestoreResolution.value) return
  if (r) persistInputs(sessionsStore.activeId, { resolution: r })
})

// ---------- session input restore ----------
// Re-apply the active session's saved composer inputs when the session
// changes. The catalog is a watch source so a first run with an empty hub
// cache (catalog still null when the sessions store loads) re-applies once
// the catalog arrives — but every applied/degraded/absent attempt records
// `appliedForId`, making later catalog changes (hub rescans) no-ops: a
// background rescan must never snap the composer back to the saved inputs
// mid-edit nor clear a fresh pick in a previously-blank session.
watch(
  [() => sessionsStore.activeId, () => appStore.catalog],
  ([activeId, catalog]) => {
    // No active session (mount happens before `sessionsStore.load()`, or the
    // last session was deleted): do nothing and record nothing.
    if (!activeId) return
    const session = sessionsStore.sessions.find((x) => x.id === activeId)
    if (!session) return
    if (appliedForId === activeId && !restoreUnresolved) return

    // Every branch clears the marker first — a degraded or absent restore
    // must not leave it set, or the suppressed resolution watchers would
    // stay disabled for the rest of the app run. Only the found branch sets
    // it again, from `inputs.resolution`, and only when the resolved entry
    // differs from the currently selected one (a reference-equal assignment
    // never fires the model watcher, so a marker armed there would never be
    // consumed and the saved resolution would go unapplied).
    pendingRestoreResolution.value = null

    const inputs = session.inputs
    if (!inputs || !inputs.model) {
      // Absent inputs: blank composer — sessions without saved inputs start
      // blank (no inheritance, no backfill). Clearing the model cascades the
      // blank state to VAE/encoder/vision/resolution via the model watcher.
      appliedForId = activeId
      restoreUnresolved = false
      modelEntry.value = null
      return
    }

    if (!catalog) {
      // First run with an empty hub cache: the catalog can still be null
      // when the sessions store loads. Record nothing and keep
      // `restoreUnresolved` set — the flag alone re-arms this re-apply when
      // the catalog arrives. The composer keeps showing the previous
      // session's model meanwhile (transient mislabel, accepted).
      restoreUnresolved = true
      return
    }

    const resolved =
      catalog.entries.find(
        (e) =>
          e.type === 'diffusion' &&
          e.diffusionType === inputs.diffusionType &&
          e.name === inputs.model
      ) ?? null

    if (!resolved) {
      // Saved model no longer resolves in the catalog (file deleted, hub
      // rescan): degrade to "Select model" — the saved inputs stay on disk
      // and the model may reappear after a rescan. Never erase.
      appliedForId = activeId
      restoreUnresolved = false
      modelEntry.value = null
      return
    }

    appliedForId = activeId
    restoreUnresolved = false

    if (modelEntry.value === resolved) {
      // Same-entry restore: assigning `modelEntry` would be a no-op
      // (identical reference — Vue never fires the watcher), so the marker
      // would never be consumed. Apply the saved resolution directly —
      // `resolutions.value` is already correct here (the diffusion type did
      // not change): the listed entry matching width+height, else the first.
      const saved = inputs.resolution
      resolution.value =
        (saved && resolutions.value.find((x) => x.width === saved.width && x.height === saved.height)) ||
        resolutions.value[0] ||
        null
      return
    }

    // Different entry: arm the one-shot marker and assign — the model
    // watcher derives VAE/encoder/vision and applies the saved resolution
    // (matched against the new list, else the first entry) before clearing
    // the marker.
    pendingRestoreResolution.value = inputs.resolution ?? null
    modelEntry.value = resolved
  },
  { immediate: true }
)

async function addRefs(): Promise<void> {
  const picked = await window.api.pickImages()
  for (const p of picked) {
    if (refImages.value.length >= maxRef.value) {
      toast(`Maximum of ${maxRef.value} reference images`, 'error')
      break
    }
    if (!refImages.value.includes(p)) refImages.value.push(p)
  }
}
function removeRef(p: string): void {
  refImages.value = refImages.value.filter((x) => x !== p)
}

// Drag-and-drop reference images onto the composer. Files dragged in from the OS
// file explorer arrive as File objects whose `path` is the absolute disk path
// Electron exposes; `window.api.imageFromPath` reads them back for thumbnails.
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragActive.value = true
}
function onDragLeave(e: DragEvent): void {
  // Only hide the highlight when leaving the textarea itself, not a child node.
  if (e.relatedTarget === (e.currentTarget as HTMLElement)) dragActive.value = false
}
function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragActive.value = false
  void addDroppedFiles(Array.from(e.dataTransfer.files))
}
async function addDroppedFiles(files: File[]): Promise<void> {
  if (!refsEnabled.value) return
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      toast(`"${file.name}" is not an image`, 'error')
      continue
    }
    if (refImages.value.length >= maxRef.value) {
      toast(`Maximum of ${maxRef.value} reference images`, 'error')
      break
    }
    const path = (file as File & { path?: string }).path
    if (!path) {
      toast(`Cannot use "${file.name}" as a reference`, 'error')
      continue
    }
    if (!refImages.value.includes(path)) refImages.value.push(path)
  }
}

// Guards against a second Enter/click during the pre-generation window (model
// downloads + IPC) submitting the same prompt twice before `busy` flips.
let starting = false

async function generate(): Promise<void> {
  // Reject invalid input synchronously so the UI reacts instantly (no perceived
  // lag) and never flips into the busy state for input that won't be sent.
  if (!modelEntry.value) {
    toast('Select a model first', 'error')
    return
  }
  const text = prompt.value.trim()
  if (!text) {
    toast('Enter a prompt', 'error')
    return
  }
  // Guard so a second Enter/click during the pre-generation window can't submit
  // the same prompt twice before `busy` flips.
  if (starting) return
  starting = true
  try {
    // No session (e.g. the last one was deleted) — create one and continue.
    if (!sessionsStore.activeId) {
      try {
        await sessionsStore.create()
      } catch (err) {
        toast(`No active session (${(err as Error).message})`, 'error')
        return
      }
    }
    // Flip into the busy state synchronously (before any awaited download/IPC)
    // so the button immediately shows Stop and the panel has feedback. The
    // optimistic prompt is shown right away too; the user's text is restored if
    // pre-generation later fails.
    const refs = [...refImages.value]
    pendingPrompt.value = text
    pendingRefs.value = refs
    busy.value = true
    progress.value = null
    prompt.value = ''
    refImages.value = []
    // Ensure the diffusion model and the VAE / text encoder / vision deps are on
    // disk (and complete) before spawning. Waits for an in-flight download, or
    // starts one if none is running. On the bundle path `encoderEntry` is null,
    // so the bundle entries must be iterated here too or the text encoders
    // would silently be skipped.
    for (const e of [
      modelEntry.value,
      vaeEntry.value,
      encoderEntry.value,
      ...encoderBundle.value,
      visionEntry.value
    ]) {
      if (!e) continue
      try {
        await ensureDownloaded(e)
      } catch (err) {
        prompt.value = text
        refImages.value = [...refs]
        pendingPrompt.value = null
        pendingRefs.value = []
        busy.value = false
        toast((err as Error).message, 'error')
        return
      }
    }

    const s = sessionSampling.value
    // Belt-and-braces with the allowRef watcher: the previous image is chained
    // only when the user opted in AND the diffusion type allows references.
    const chainPrevious = usePrevious.value && allowRef.value
    const req: GenerationRequest = {
      sessionId: sessionsStore.activeId,
      prompt: text,
      model: modelEntry.value.name,
      diffusionType: modelEntry.value.diffusionType,
      vae: vaeEntry.value?.name,
      // Provider disambiguates a basename collision across provider folders
      // (e.g. sd3_5's `diffusion_pytorch_model.safetensors` exists under both
      // black_forest_labs and huaweilin). Without this main resolves by
      // basename and picks whichever folder sorts first.
      vaeProvider: vaeEntry.value?.provider,
      // Bundle wins at spawn time: gen:start ignores `encoder` when `encoders`
      // is non-empty. On the bundle path `encoder` is omitted entirely.
      ...(encoderBundle.value.length
        ? { encoders: encoderBundle.value.map((e) => ({ name: e.name, useAs: e.useAs, provider: e.provider })) }
        : { encoder: encoderEntry.value?.name, encoderProvider: encoderEntry.value?.provider }),
      vision: visionEntry.value?.name,
      // The resolution selected in the chat panel always wins; per-session
      // width/height overrides are no longer supported.
      resolution:
        resolution.value
          ? { width: resolution.value.width, height: resolution.value.height }
          : { width: s?.width ?? 1024, height: s?.height ?? 1024 },
      referencePaths: [...refs],
      usePrevious: chainPrevious,
      // omitted entirely when unchecked or disallowed — the request payload
      // carries no previous image unless the user explicitly opted in
      previousImagePath: chainPrevious ? sessionsStore.lastGeneratedImage : undefined,
      steps: s?.steps ?? 25,
      cfg: s?.cfg ?? 1.0,
      sampler: s?.sampler ?? DEFAULT_SAMPLER,
      // RAW merged value — a concrete string, the 'model-specific' sentinel, or
      // null. Main resolves the sentinel + the global fallback (§2.2);
      // pre-resolving here would erase the distinction between "picked
      // model-specific" and "no scheduler chosen".
      scheduler: s?.scheduler ?? undefined,
      negativePrompt: sessionNegative.value.trim() || undefined,
      strength: s?.strength ?? 0.75
    }
    try {
      await window.api.genStart(req)
      // Main has persisted the messages by now — load them first so the optimistic
      // placeholders are replaced by the real ones, then drop the placeholders.
      await sessionsStore.refreshActive()
      pendingPrompt.value = null
      pendingRefs.value = []
    } catch (err) {
      prompt.value = text
      refImages.value = [...refs]
      pendingPrompt.value = null
      pendingRefs.value = []
      busy.value = false
      void sessionsStore.refreshActive()
      toast((err as Error).message, 'error')
    }
  } finally {
    starting = false
  }
}

function stop(): void {
  if (sessionsStore.activeId) void window.api.genStop(sessionsStore.activeId)
}

// ---------- per-session dialogs ----------
async function onSaveNegative(draft: string): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { negativePrompt: draft.trim() })
  negOpen.value = false
}
async function onSaveSampling(draft: SessionSamplingOverride | null): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { sampling: draft })
  samplingOpen.value = false
}

const lastMessage = computed(() => {
  const msgs = sessionsStore.active?.messages
  return msgs && msgs.length ? msgs[msgs.length - 1] : null
})

async function removeLastMessage(): Promise<void> {
  const m = lastMessage.value
  if (!m || busy.value) return
  try {
    await sessionsStore.removeMessage(m.id)
  } catch (err) {
    toast((err as Error).message, 'error')
  }
}

function onGenProgress(p: {
  sessionId: string
  messageId: string
  status: 'running' | 'done' | 'stopped' | 'error'
  step?: number
  totalSteps?: number
  image?: { path: string; name: string }
  error?: string
}): void {
  if (p.sessionId !== sessionsStore.activeId) return
  // Real messages are now flowing from main — drop the optimistic placeholders.
  pendingPrompt.value = null
  pendingRefs.value = []
  if (p.status === 'running' && p.step !== undefined) {
    progress.value = { step: p.step, total: p.totalSteps ?? 0 }
  }
  if (p.status === 'done') {
    busy.value = false
    progress.value = null
    toast('Image generated', 'ok')
  }
  if (p.status === 'stopped') {
    busy.value = false
    progress.value = null
    toast('Generation stopped', 'info')
  }
  if (p.status === 'error') {
    busy.value = false
    progress.value = null
    toast(p.error ?? 'Generation failed', 'error', 8000)
  }
  // Real messages are now flowing from main — load them and drop the
  // optimistic placeholders.
  void sessionsStore.refreshActive()
  pendingPrompt.value = null
  pendingRefs.value = []
}

function scrollToBottom(): void {
  void nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied to clipboard', 'ok')
  } catch {
    toast('Failed to copy', 'error', 6000)
  }
}

function autoGrow(): void {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

onMounted(async () => {
  window.api.onGenProgress(onGenProgress)
  await refreshInstalled()
  scrollToBottom()
})
onBeforeUnmount(() => {
  // listeners are process-lifetime in this app; nothing to clean up
})

watch(() => sessionsStore.active?.messages.length, scrollToBottom)
watch(() => sessionsStore.activeId, () => {
  busy.value = false
  progress.value = null
  scrollToBottom()
})

function fmtBytes(n: number): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}
</script>

<template>
  <section class="chatpanel">
    <header class="chat-header">
      <div class="chat-title">
        <span class="chat-avatar">✨</span>
        <h2>{{ sessionsStore.active?.name ?? 'Myriad Frame' }}</h2>
      </div>
      <span v-if="sessionsStore.active" class="muted faint">
        {{ sessionsStore.active.messages.length }} message{{ sessionsStore.active.messages.length === 1 ? '' : 's' }}
      </span>
    </header>

    <div ref="messagesEl" class="messages">
      <!-- empty state -->
      <div v-if="!sessionsStore.active" class="empty-state">
        <div class="empty-avatar">◈</div>
        <h3>Welcome to Myriad Frame</h3>
        <p>Create or select a session on the left to start generating images.</p>
      </div>

      <!-- messages -->
      <template v-else>
        <!-- optimistic prompt: shown locally between Send and the moment
             main persists the real messages, so the panel is never empty
             while the red Stop button is up. -->
        <div
          v-if="pendingPrompt !== null"
          class="msg user"
        >
          <div class="avatar user">🐈‍⬛</div>
          <div class="bubble">
            <div class="msg-text">{{ pendingPrompt }}</div>
            <div v-if="pendingRefs.length" class="refs">
              <ImageFromPath v-for="(r, i) in pendingRefs" :key="i" :path="r" :alt="'reference ' + (i + 1)" :max="120" />
            </div>
            <div class="status muted">
              <span class="spinner"></span>
              Generating
              <template v-if="progress && progress.total"> · step {{ progress.step }}/{{ progress.total }}</template>
            </div>
          </div>
        </div>

        <div
          v-for="m in sessionsStore.active.messages"
          :key="m.id"
          class="msg"
          :class="[m.role, { pending: m.role === 'assistant' && busy && !m.image && m.status !== 'error' && m.status !== 'stopped' }]"
        >
          <div class="avatar" :class="m.role">
            <img v-if="m.role === 'assistant'" :src="logoTiny" alt="Myriad Frame" class="avatar-logo" />
            <span v-else>🐈‍⬛</span>
          </div>
          <div class="bubble">
            <div v-if="m.text" class="msg-text">{{ m.text }}</div>

            <!-- user reference thumbnails -->
            <div v-if="m.refs && m.refs.length" class="refs">
              <ImageFromPath v-for="(r, i) in m.refs" :key="i" :path="r" :alt="'reference ' + (i + 1)" :max="120" />
            </div>

            <!-- assistant generating indicator -->
            <div
              v-if="m.role === 'assistant' && busy && !m.image && m.status !== 'error' && m.status !== 'stopped'"
              class="gen-indicator"
            >
              <span class="spinner"></span>
              <span class="muted">
                Generating
                <template v-if="progress && progress.total">
                  · step {{ progress.step }}/{{ progress.total }}
                </template>
              </span>
              <span class="dots"><span></span><span></span><span></span></span>
            </div>

            <!-- assistant image -->
            <div v-else-if="m.image" class="image-wrap">
              <ImageFromPath :path="m.image.path" alt="generated image" :max="480" clickable />
              <button
                class="icon save-image"
                title="Save image as…"
                @click="saveImageAs(m.image.path)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
              </button>
            </div>

            <!-- stopped / error -->
            <div v-if="m.status === 'stopped'" class="status muted">Generation stopped</div>
            <div v-if="m.status === 'error'" class="status error">{{ m.error }}</div>
          </div>
          <button
            v-if="m.text"
            class="msg-copy"
            title="Copy message"
            @click="copyText(m.text)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            v-if="m.id === lastMessage?.id && !busy"
            class="msg-delete"
            title="Delete last message"
            @click="removeLastMessage()"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </div>
      </template>
    </div>

    <!-- composer -->
    <footer class="composer-wrap">
      <div class="composer">
        <!-- reference image previews -->
        <div v-if="refImages.length" class="refs">
          <div v-for="p in refImages" :key="p" class="ref-thumb">
            <ImageFromPath :path="p" :max="72" />
            <button class="icon remove" title="Remove" @click="removeRef(p)">×</button>
          </div>
        </div>

        <!-- auto-downloading VAE / text encoder dependencies -->
        <div v-if="depDownloads.length" class="dep-dl">
          <DownloadProgress
            v-for="d in depDownloads"
            :key="d.key"
            :label="d.label"
            :downloaded-bytes="d.state.downloadedBytes"
            :total-bytes="d.state.totalBytes"
          />
        </div>

        <div class="composer-main">
          <textarea
            ref="textareaEl"
            v-model="prompt"
            rows="1"
            placeholder="Describe the image you want to create…"
            :disabled="busy"
            :class="{ 'drag-over': dragActive }"
            @input="autoGrow()"
            @keydown.enter.exact.prevent="generate()"
            @dragover="onDragOver($event)"
            @dragleave="onDragLeave($event)"
            @drop="onDrop($event)"
          ></textarea>
          <button class="gen-btn" :class="{ stop: busy }" :disabled="!busy && !prompt.trim()" @click="busy ? stop() : generate()">
            <svg v-if="!busy" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            {{ busy ? 'Stop' : 'Send' }}
          </button>
        </div>

        <div class="composer-tools">
          <button class="icon" title="Add reference images" :disabled="busy || !refsEnabled || refImages.length >= maxRef" @click="addRefs()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </button>
          <button
            class="icon"
            :class="{ active: sessionNegative }"
            title="Negative prompt"
            aria-label="Negative prompt"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="negOpen = true"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M4.9 4.9l14.2 14.2" />
            </svg>
          </button>
          <button
            class="icon"
            :class="{ active: sessionsStore.active?.inputs?.sampling }"
            title="Sampling override"
            aria-label="Sampling override"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="samplingOpen = true"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="9" cy="6" r="2" fill="currentColor" />
              <circle cx="16" cy="12" r="2" fill="currentColor" />
              <circle cx="11" cy="18" r="2" fill="currentColor" />
            </svg>
          </button>
          <span v-if="refImages.length" class="muted faint">
            {{ refImages.length }}/{{ maxRef }} reference{{ refImages.length === 1 ? '' : 's' }}
          </span>
          <label v-if="allowRef" class="chk">
            <input v-model="usePrevious" type="checkbox" :disabled="busy" />
            Use previous image
          </label>
          <button
            class="model-chip"
            title="Model"
            aria-haspopup="dialog"
            aria-label="Select model"
            :disabled="busy"
            @click="pickerOpen = true"
          >
            <span class="model-chip-label">{{ modelLabel }}</span>
            <svg class="model-chip-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <select v-model="resolution" title="Resolution" :disabled="busy || !resolutions.length">
            <option v-for="r in resolutions" :key="r.name" :value="r">{{ r.name }} ({{ r.width }}×{{ r.height }})</option>
          </select>
          <span v-if="sessionSampling" class="faint mono ml-auto">
            {{ sessionSampling.steps }} steps · cfg {{ sessionSampling.cfg }} · {{ sessionSampling.sampler }} · {{ sessionSampling.scheduler || 'model-specific' }}
          </span>
        </div>
      </div>
    </footer>

    <ModelPickerDialog
      v-if="pickerOpen"
      :selected="modelEntry"
      @select="onPick"
      @close="pickerOpen = false"
    />
    <NegativePromptDialog
      v-if="negOpen"
      :session-name="sessionsStore.active?.name ?? ''"
      @save="onSaveNegative"
      @close="negOpen = false"
    />
    <SessionSamplingDialog
      v-if="samplingOpen"
      :session-name="sessionsStore.active?.name ?? ''"
      @save="onSaveSampling"
      @close="samplingOpen = false"
    />
  </section>
</template>

<style scoped>
.chatpanel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}
.chat-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.chat-title h2 {
  margin: 0;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.empty-state {
  margin: auto;
  text-align: center;
  color: var(--text-dim);
  max-width: 420px;
}
.empty-state h3 {
  color: var(--text);
  margin: 14px 0 6px;
  font-size: 18px;
}
.empty-state p {
  margin: 0;
  font-size: 13px;
}
.empty-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
}
.msg {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.msg.user {
  justify-content: flex-end;
}
.msg.assistant {
  justify-content: flex-start;
}
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
}
.avatar.assistant {
  background: var(--accent-soft);
  color: var(--accent);
}
.avatar-logo {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: contain;
}
.avatar.user {
  background: var(--bg-hover);
  color: var(--text-dim);
}
.bubble {
  max-width: 72%;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg.user .bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  border-bottom-right-radius: 6px;
}
.msg.assistant .bubble {
  border-bottom-left-radius: 6px;
}
.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
.image-wrap {
  position: relative;
  display: inline-block;
  line-height: 0;
}
.save-image {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.2);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  cursor: pointer;
}
.image-wrap:hover .save-image {
  opacity: 1;
}
.save-image:hover {
  background: rgba(0, 0, 0, 0.7);
}
.ref-thumb .remove {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--danger);
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 18px;
  height: 18px;
  line-height: 1;
  padding: 0;
  font-size: 12px;
}
.ref-thumb .remove:hover {
  background: #ff8585;
}
.gen-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
}
.status {
  font-size: 12px;
}
.status.error {
  color: var(--danger);
}
.composer-wrap {
  padding: 8px 16px 16px;
}
.composer {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.25);
}
.composer:focus-within {
  border-color: var(--accent);
}
.composer-main {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.composer-main textarea {
  flex: 1;
  resize: none;
  min-height: 40px;
  max-height: 160px;
  background: transparent;
  border: none;
  padding: 8px 4px;
  line-height: 1.5;
}
.composer-main textarea:focus {
  border: none;
  box-shadow: none;
}
.drag-over {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.gen-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
  border-radius: 999px;
  overflow: hidden;
}
.gen-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.gen-btn.stop {
  background: var(--danger);
  border-color: var(--danger);
}
.gen-btn.stop:hover:not(:disabled) {
  background: #ff8585;
}
.composer-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.composer-tools select {
  max-width: 220px;
  background: var(--bg-elevated);
  font-size: 12px;
  padding: 4px 8px;
}
/* model picker chip — replaces the old model <select>; the shared
   .composer-tools select max-width no longer applies to a <button>, so the
   chip carries its own width constraint so the tools row cannot stretch
   under the long modelLabel (full repo path + quant) */
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  min-width: 0;
  padding: 4px 10px;
  font-size: 12px;
  background: var(--bg-elevated);
}
.model-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-chip-chevron {
  flex-shrink: 0;
  color: var(--text-dim);
}
.dep-dl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 4px 0;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}
.ml-auto {
  margin-left: auto;
}
.ref-thumb {
  position: relative;
  display: inline-block;
}
.msg-copy {
  align-self: center;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  color: var(--text-faint);
  background: transparent;
  border: 1px solid transparent;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.msg:hover .msg-copy,
.msg:hover .msg-delete {
  opacity: 1;
}
.msg-copy:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: transparent;
}
.msg-delete {
  align-self: center;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  color: var(--text-faint);
  background: transparent;
  border: 1px solid transparent;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.msg:hover .msg-delete {
  opacity: 1;
}
.msg-delete:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}
</style>
