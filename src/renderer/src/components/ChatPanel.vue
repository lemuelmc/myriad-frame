<!--
Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
Author: Lemuel Raganas
License: Apache License 2.0 — permissive; allows use, modification, and distribution
(commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  CatalogEntry,
  GenerationRequest,
  ModelType,
  ResolutionEntry,
  SessionInputs,
  SessionIpAdapter,
  SessionControlNet,
  SessionLora,
  SessionSamplingOverride,
  AdetailerSettings
} from '@shared/types'
import {
  DOWNLOAD_ABORTED_MESSAGE,
  FALLBACK_SAMPLING,
  applySamplingOverrides,
  isValidSeed
} from '@shared/types'
import { useAppStore } from '../stores/app'
import { useResizeStore } from '../stores/resize'
import { useSessionsStore } from '../stores/sessions'
import { useGenerationStore } from '../stores/generation'
import { useSettingsStore, type ModelDownloadState } from '../stores/settings'
import { useUpscalerStore } from '../stores/upscaler'
import {
  hubEntryNameFor,
  requiredCompanionsFor,
  requiredEncoderBundle,
  resolveEncoderBundle,
  type EncoderBundleEntry
} from '../deps'
import { baseName } from '../search'
import { toast } from '../toast'
import { confirm } from '../confirm'
import { saveImageAs } from '../saveImage'
import ImageFromPath from './ImageFromPath.vue'
import DownloadProgress from './DownloadProgress.vue'
import ModelPickerDialog from './ModelPickerDialog.vue'
import ResolutionSelectorDialog from './ResolutionSelectorDialog.vue'
import { matchesPresetDimensions } from './resolutionMath'
import NegativePromptDialog from './NegativePromptDialog.vue'
import SessionSamplingDialog from './SessionSamplingDialog.vue'
import LoraDialog from './LoraDialog.vue'
import InpaintDialog from './InpaintDialog.vue'
import OutpaintDialog, { type OutpaintMargins } from './OutpaintDialog.vue'
import PaintDialog from './PaintDialog.vue'
import AdetailerDialog from './AdetailerDialog.vue'
import IpAdapterDialog from './IpAdapterDialog.vue'
import ControlNetDialog from './ControlNetDialog.vue'
import logoTiny from '../../../assets/logo-square-tiny.png'

const appStore = useAppStore()
const resizeStore = useResizeStore()
const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()
const upscalerStore = useUpscalerStore()
const genStore = useGenerationStore()

// ---------- composer state ----------
const prompt = ref('')
const modelEntry = ref<CatalogEntry | null>(null)
const vaeEntry = ref<CatalogEntry | null>(null)
const encoderEntry = ref<CatalogEntry | null>(null)
// SD3.5-style encoder bundle (`defaults[]`): non-empty for bundle diffusion
// types, in which case `encoderEntry` stays null and the bundle wins.
const encoderBundle = ref<EncoderBundleEntry[]>([])
const visionEntry = ref<CatalogEntry | null>(null)
const tokenizerEntry = ref<CatalogEntry | null>(null)
// Audio encoder (wav2vec2 — Wan2.2 S2V); resolved from the required family.
const audioEncoderEntry = ref<CatalogEntry | null>(null)
// LTX 2.5 companions (audio VAE + latent upscaler); resolved from the
// diffusion type itself (no `requires` indirection).
const audioVaeEntry = ref<CatalogEntry | null>(null)
const latentUpscalerEntry = ref<CatalogEntry | null>(null)
const resolution = ref<ResolutionEntry | null>(null)
// Unified resolution selector state (plans/unified-resolution-selector.md):
// `resOpen` mounts the dialog; `isCustomResolution` marks the current value
// as an intentional unlisted custom size so the `watch(resolutions)` guard
// never snaps it to the first preset. Maintained on EVERY `resolution.value`
// assignment path (dialog select, model watcher default + restore, same-type
// restore).
const resOpen = ref(false)
const isCustomResolution = ref(false)
const refImages = ref<string[]>([])
const inputImages = ref<string[]>([])
const busy = ref(false)
// True while a drag is hovering over the textarea, for the drop highlight.
const dragActive = ref(false)
const progress = ref<{ step: number; total: number } | null>(null)
// True while the post-generation .avi → .mp4 conversion runs (gen:progress
// status 'converting') — keeps the busy indicator up with a different label.
const converting = ref(false)
// Optimistic prompt shown locally the instant Send is clicked, before the main
// process persists the messages and streams the first progress event.
const pendingPrompt = ref<string | null>(null)
const pendingRefs = ref<string[]>([])
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
// Model picker dialog (replaces the old composer model <select>).
const pickerOpen = ref(false)
// Negative-prompt + sampling-override + lora dialogs.
const negOpen = ref(false)
const samplingOpen = ref(false)
const loraOpen = ref(false)
const adetailerOpen = ref(false)
const ipAdapterOpen = ref(false)
const controlNetOpen = ref(false)
// Preview dialog state — shows the full sd-cli command line without running it.
const previewOpen = ref(false)
const previewCommand = ref('')
const previewError = ref('')

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
  // family: the NEW key for the model's diffusion family — new saves carry
  // `family` INSTEAD of `diffusionType` (the legacy key is dropped here so a
  // re-pick migrates the pending patch to the new shape).
  if (patch.family !== undefined) {
    merged.family = patch.family
    delete merged.diffusionType
  } else if (patch.diffusionType !== undefined) merged.diffusionType = patch.diffusionType
  if (patch.modelProvider !== undefined) merged.modelProvider = patch.modelProvider
  if (patch.diffusionName !== undefined) merged.diffusionName = patch.diffusionName
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
    if (patch.family !== undefined) {
      effective.family = patch.family
      delete effective.diffusionType
    }
    if (patch.diffusionType !== undefined) effective.diffusionType = patch.diffusionType
    if (patch.diffusionName !== undefined) effective.diffusionName = patch.diffusionName
    if (patch.resolution !== undefined) effective.resolution = patch.resolution
    const changed =
      (effective.model ?? undefined) !== (saved.model ?? undefined) ||
      (effective.family ?? undefined) !== (saved.family ?? undefined) ||
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
// The chip button's label: the selected dimensions (the button shows the
// dimension, not the preset name).
const resolutionLabel = computed(() =>
  resolution.value ? `${resolution.value.width}×${resolution.value.height}` : 'Resolution'
)

function onResolutionSelect(entry: ResolutionEntry): void {
  resolution.value = entry
  isCustomResolution.value = !matchesPresetDimensions(entry, resolutions.value)
  resOpen.value = false
}
const sampling = computed(() => {
  // Complete the configured entry over the shared fallback — gen:start reads
  // every descriptor UNGUARDED, and an entry may predate a key (boogu_image
  // lacks `control_video`).
  const cfg = appStore.configs
  if (!cfg) return null
  const base = { ...FALLBACK_SAMPLING, ...(cfg.sampling[diffusionType.value] ?? {}) }
  return settingsStore.samplingFor(diffusionType.value, base)
})
// Per-session negative prompt (empty ⇒ inherit the global default).
const sessionNegative = computed(() => sessionsStore.active?.inputs?.negativePrompt ?? '')
// Sampling for this session: the flat session override merges into the
// descriptor defaults (shared `applySamplingOverrides`). Because
// `sessionSampling` is the source for the request fields and the summary,
// session overrides flow everywhere automatically.
const sessionSampling = computed(() => {
  const cfg = appStore.configs
  if (!cfg) return null
  const base = { ...FALLBACK_SAMPLING, ...(cfg.sampling[diffusionType.value] ?? {}) }
  return applySamplingOverrides(settingsStore.samplingFor(diffusionType.value, base), sessionsStore.active?.inputs?.sampling)
})
// Rows for the composer's sampling-info hover popover: the configured
// sampling for the CURRENT session (descriptor defaults ← settings overrides
// ← session override — exactly what `sessionSampling` carries and what
// gen:start sends). Each row is gated by its descriptor's `show` flag, the
// same gating the Session Sampling dialog uses for its fields, so rows the
// config hides never appear. Seed is session-only (never a sampling.json
// field) and the negative prompt resolves session-override-first, mirroring
// the request build.
const samplingRows = computed(() => {
  const s = sessionSampling.value
  if (!s) return []
  const rows: { label: string; value: string; title?: string }[] = []
  if (s.steps.show) rows.push({ label: 'Steps', value: s.steps.default == null ? 'auto' : String(s.steps.default) })
  if (s.high_steps?.show) rows.push({ label: 'High-noise steps', value: s.high_steps.default == null ? 'auto' : String(s.high_steps.default) })
  if (s.cfg.show) rows.push({ label: 'CFG scale', value: s.cfg.default == null ? 'auto' : String(s.cfg.default) })
  if (s.high_cfg?.show) rows.push({ label: 'High-noise CFG', value: s.high_cfg.default == null ? 'auto' : String(s.high_cfg.default) })
  if (s.strength.show) rows.push({ label: 'Strength', value: s.strength.default == null ? 'auto' : String(s.strength.default) })
  if (s.sampler.show) rows.push({ label: 'Sampler', value: s.sampler.default || '(model default)' })
  if (s.high_sampler?.show) rows.push({ label: 'High-noise sampler', value: s.high_sampler.default || '(model default)' })
  if (s.scheduler.show) rows.push({ label: 'Scheduler', value: s.scheduler.default || 'model-specific' })
  if (s.flow_shift.show) rows.push({ label: 'Flow shift', value: typeof s.flow_shift.default === 'number' ? String(s.flow_shift.default) : '(none)' })
  if (s.frames?.show) rows.push({ label: 'Video frames', value: String(s.frames.default ?? 0) })
  if (s.frame_rate?.show) rows.push({ label: 'Frame rate', value: `${s.frame_rate.default ?? 0} fps` })
  const seed = sessionsStore.active?.inputs?.sampling?.seed
  rows.push({ label: 'Seed', value: isValidSeed(seed) ? `fixed ${seed}` : 'random' })
  const extraArgs = sessionsStore.active?.inputs?.sampling?.args?.trim()
  if (extraArgs) rows.push({ label: 'Args', value: extraArgs.length > 96 ? `${extraArgs.slice(0, 96)}…` : extraArgs, title: extraArgs })
  const neg = sessionNegative.value.trim() || s.negative.default?.trim() || ''
  if (neg) rows.push({ label: 'Negative', value: neg.length > 96 ? `${neg.slice(0, 96)}…` : neg, title: neg })
  // Debugging aid: the session id — locates data/sessions/<id>.json (the
  // per-session sampling override feeding the rows above) without digging
  // through the data folder. Hover shows the file path.
  const sessionId = sessionsStore.active?.id
  if (sessionId) rows.push({ label: 'Session', value: sessionId, title: `data/sessions/${sessionId}.json` })
  return rows
})
const maxRef = computed(() => sampling.value?.image_reference.max ?? 0)
const maxInput = computed(() => sampling.value?.image_input.max ?? 0)
// 'Add reference images' is offered only for diffusion types whose sampling
// config shows the reference channel (configurations/sampling.json).
const allowRef = computed(() => sampling.value?.image_reference.show === true)
// 'Add input images' is offered only for types whose config shows the input
// channel (--init-img).
const allowInput = computed(() => sampling.value?.image_input.show === true)
// 'Use previous image' is offered only for types whose config shows the
// feature (configurations/sampling.json `use_previous_image.show`) — hidden
// entirely for the WAN vid_gen families, where chaining the generated video
// as an image makes no sense. The checkbox's initial state is the
// descriptor's `default` until the user toggles it (the toggle then persists
// across diffusion-type switches); the stale-state watch below still clears
// it when the gate turns off.
const allowPreviousImage = computed(() => sampling.value?.use_previous_image.show === true)
const usePreviousUser = ref<boolean | null>(null)
const usePrevious = computed({
  get: () => usePreviousUser.value ?? sampling.value?.use_previous_image.default ?? true,
  set: (v: boolean) => {
    usePreviousUser.value = v
  }
})
// Video-era channels (WAN): driving audio (--audio), control-frames directory
// (--control-video) and end image (--end-img). The control-video gate is the
// `control_video` descriptor's `show` (NOT video_input — that channel is
// reserved; the anima entry proves the distinction).
const allowAudio = computed(() => sampling.value?.audio_input.show === true)
const allowControlVideo = computed(() => sampling.value?.control_video?.show === true)
const allowEndImage = computed(() => sampling.value?.end_image_input.show === true)
// Repeatable reference channels (--ref-audio / --ref-video, MiniMax-H3
// Ref2VA) — image_reference-style arrays capped by the channel `max`.
const allowAudioRef = computed(() => sampling.value?.audio_reference?.show === true)
const maxAudioRef = computed(() => sampling.value?.audio_reference?.max ?? 0)
const allowVideoRef = computed(() => sampling.value?.video_reference?.show === true)
const maxVideoRef = computed(() => sampling.value?.video_reference?.max ?? 0)
const refsEnabled = computed(() => allowRef.value && maxRef.value > 0)
const inputsEnabled = computed(() => allowInput.value && maxInput.value > 0)
// Sticky video-era channel states (single-valued flags — one path each).
const audioPath = ref('')
const controlVideoPath = ref('')
const endImagePath = ref('')
// Sticky repeatable reference-channel states (arrays — one chip per path).
const audioRefPaths = ref<string[]>([])
const videoRefPaths = ref<string[]>([])
// Stale-state reset on diffusion-type switches: clear each channel when its
// gate turns off, and uncheck 'Use previous image' when its own gate turns
// off or when transitioning into the fully-forbidden state (the checkbox is
// offered when either channel is enabled).
watch(
  [allowRef, allowInput, allowPreviousImage],
  ([refOk, inputOk, chainOk], [prevRefOk, prevInputOk, prevChainOk]) => {
    if (!refOk) refImages.value = []
    if (!inputOk) inputImages.value = []
    if (!chainOk && prevChainOk) usePrevious.value = false
    if (!refOk && !inputOk && (prevRefOk || prevInputOk)) usePrevious.value = false
  }
)
// How the previous image is chained: 'input' (--init-img) or 'reference'
// (--ref-image). The user picks the mode in the composer dropdown; it
// defaults to 'reference' and persists across sends within the session.
const previousMode = ref<'input' | 'reference'>('reference')

// ---------- inpaint / outpaint (mask) ----------
/** Sticky composer mask state — paths only, never data URLs (the background
 *  and the saved mask are re-resolved via imageFromPath when a dialog opens;
 *  outpaint restores its sliders from `margins`). Sticky until Clear: once
 *  saved, the mask applies to every Send. */
interface ComposerMaskState {
  kind: 'inpaint' | 'outpaint'
  maskPath: string
  /** outpaint only — the padded init image passed as --init-img */
  initPath?: string
  /** image-derived request size used when overrideResolution is off */
  width: number
  height: number
  /** outpaint only — slider values, restored on reopen */
  margins?: OutpaintMargins
  /** the image the mask was drawn on (inpaint: the background; outpaint: the
   *  ORIGINAL image, so reopening re-derives sliders from it) */
  backgroundPath: string
  overrideResolution: boolean
}
const maskState = ref<ComposerMaskState | null>(null)
const inpaintOpen = ref(false)
const outpaintOpen = ref(false)
const inpaintBg = ref('')
const outpaintBg = ref('')
const inpaintRestoredMask = ref('')
const outpaintRestoredMargins = ref<OutpaintMargins | null>(null)
const inpaintOverride = ref(false)
const outpaintOverride = ref(false)
// The background path captured at open time — the dialogs only receive data
// URLs, so the panel remembers which file was shown (plain bookkeeping).
let maskBgPath = ''

// `allow_inpainting.show` HIDES both mask buttons (configurations/sampling.json)
// — v-if, not disabled, mirroring the paint button's `allow_painting` gate.
const allowInpainting = computed(() => sampling.value?.allow_inpainting.show === true)
// `allow_painting.show` gates the Paint button — a separate feature flag from
// allow_inpainting: painting produces a MERGED image, not a mask.
const allowPainting = computed(() => sampling.value?.allow_painting.show === true)
// `adetailer.show` gates the ADetailer button — a separate feature flag,
// absent/`show: false` ⇒ the button is hidden (v-if, not disabled).
const allowAdetailer = computed(() => sampling.value?.adetailer?.show === true)
// `ip_adapter.show` gates the IP Adapter button — a separate feature flag,
// absent/`show: false` ⇒ the button is hidden (v-if, not disabled).
const allowIpAdapter = computed(() => sampling.value?.ip_adapter?.show === true)
// `control_net.show` gates the Control Net button — a separate feature flag,
// absent/`show: false` ⇒ the button is hidden (v-if, not disabled).
const allowControlNet = computed(() => sampling.value?.control_net?.show === true)
// Clear the video-era channel states when their gate turns off.
watch([allowAudio, allowControlVideo, allowEndImage], ([a, c, e]) => {
  if (!a) audioPath.value = ''
  if (!c) controlVideoPath.value = ''
  if (!e) endImagePath.value = ''
})
// Clear the repeatable reference-channel states when their gate turns off.
watch([allowAudioRef, allowVideoRef], ([ar, vr]) => {
  if (!ar) audioRefPaths.value = []
  if (!vr) videoRefPaths.value = []
})
// Background availability (same rule for both dialogs): the first attached
// image wins; otherwise the previous image when 'Use previous image' is
// ticked. When a mask is active the buttons stay enabled regardless —
// reopening shows the SAVED background, not the current precedence winner.
const maskBackgroundAvailable = computed(
  () =>
    refImages.value.length > 0 ||
    inputImages.value.length > 0 ||
    (usePrevious.value && !!sessionsStore.lastGeneratedImage)
)
const inpaintDisabled = computed(
  () =>
    busy.value ||
    !sessionsStore.activeId ||
    (maskState.value?.kind !== 'inpaint' && !maskBackgroundAvailable.value)
)
const outpaintDisabled = computed(
  () =>
    busy.value ||
    !sessionsStore.activeId ||
    (maskState.value?.kind !== 'outpaint' && !maskBackgroundAvailable.value)
)
const inpaintTitle = computed(() => {
  const m = maskState.value
  if (m?.kind === 'inpaint') {
    return `Inpaint mask active — ${m.width}×${m.height}${m.overrideResolution ? ' · session resolution' : ''} — click to edit`
  }
  return 'Inpaint — paint a mask over an image'
})
const outpaintTitle = computed(() => {
  const m = maskState.value
  if (m?.kind === 'outpaint') {
    return `Outpaint mask active — ${m.width}×${m.height}${m.overrideResolution ? ' · session resolution' : ''} — click to edit`
  }
  return 'Outpaint — expand the canvas'
})

async function openInpaint(): Promise<void> {
  if (inpaintOpen.value) return
  const active = maskState.value?.kind === 'inpaint' ? maskState.value : null
  const bgPath =
    active?.backgroundPath ??
    refImages.value[0] ??
    inputImages.value[0] ??
    (usePrevious.value ? sessionsStore.lastGeneratedImage : undefined)
  if (!bgPath) return
  // Switch guard AFTER the background resolution: a confirmed switch can
  // never clear the old state and then open nothing.
  if (!(await confirmToolSwitch('inpaint'))) return
  const bg = await window.api.imageFromPath(bgPath)
  if (!bg) {
    toast('The background image no longer exists', 'error')
    return
  }
  maskBgPath = bgPath
  inpaintBg.value = bg
  inpaintOverride.value = active?.overrideResolution ?? false
  if (active) {
    // Re-open semantics: restore the SAVED mask as the initial paint layer
    // (a restored mask counts as existing paint — Save is enabled on reopen
    // without new strokes).
    const mask = await window.api.imageFromPath(active.maskPath)
    if (!mask) {
      toast('The saved mask no longer exists — clear it and paint a new one', 'error')
      return
    }
    inpaintRestoredMask.value = mask
  } else {
    inpaintRestoredMask.value = ''
  }
  inpaintOpen.value = true
}

async function openOutpaint(): Promise<void> {
  if (outpaintOpen.value) return
  const active = maskState.value?.kind === 'outpaint' ? maskState.value : null
  const bgPath =
    active?.backgroundPath ??
    refImages.value[0] ??
    inputImages.value[0] ??
    (usePrevious.value ? sessionsStore.lastGeneratedImage : undefined)
  if (!bgPath) return
  // Switch guard AFTER the background resolution: a confirmed switch can
  // never clear the old state and then open nothing.
  if (!(await confirmToolSwitch('outpaint'))) return
  const bg = await window.api.imageFromPath(bgPath)
  if (!bg) {
    toast('The background image no longer exists', 'error')
    return
  }
  maskBgPath = bgPath
  outpaintBg.value = bg
  outpaintOverride.value = active?.overrideResolution ?? false
  outpaintRestoredMargins.value = active?.margins ?? null
  outpaintOpen.value = true
}

/** One owner of the file lifecycle: a Save cleans the previous state's files
 *  via masksClear, stores the new sticky state, and sets the session's
 *  sampling strength override to 1.0 (the Session Sampling dialog shows and
 *  controls it; the next Send carries it with no extra wiring). */
async function applyMaskSave(
  kind: 'inpaint' | 'outpaint',
  patch: Omit<ComposerMaskState, 'kind'>
): Promise<void> {
  const old = maskState.value
  if (old) {
    try {
      await window.api.masksClear([old.maskPath, ...(old.initPath ? [old.initPath] : [])])
    } catch {
      /* cleanup failure is non-fatal — the launch wipe covers leftovers */
    }
  }
  maskState.value = { kind, ...patch }
  const id = sessionsStore.activeId
  if (id) {
    const prev = sessionsStore.active?.inputs?.sampling ?? {}
    try {
      await sessionsStore.setInputs(id, { sampling: { ...prev, strength: 1.0 } })
    } catch (err) {
      console.warn('[mask] saving strength override failed:', (err as Error)?.message ?? err)
    }
  }
  toast('Mask saved — it applies to every Send until cleared', 'ok')
}

async function onInpaintSave(p: {
  maskPath: string
  width: number
  height: number
  overrideResolution: boolean
}): Promise<void> {
  await applyMaskSave('inpaint', {
    maskPath: p.maskPath,
    width: p.width,
    height: p.height,
    backgroundPath: maskBgPath,
    overrideResolution: p.overrideResolution
  })
  inpaintOpen.value = false
}

async function onOutpaintSave(p: {
  maskPath: string
  initPath: string
  width: number
  height: number
  margins: OutpaintMargins
  overrideResolution: boolean
}): Promise<void> {
  await applyMaskSave('outpaint', {
    maskPath: p.maskPath,
    initPath: p.initPath,
    width: p.width,
    height: p.height,
    margins: p.margins,
    backgroundPath: maskBgPath,
    overrideResolution: p.overrideResolution
  })
  outpaintOpen.value = false
}

/** Clear: delete the saved file(s) and reset the sticky state; the open
 *  dialog stays up with a wiped canvas / zeroed sliders for fresh painting. */
async function onMaskClear(): Promise<void> {
  const st = maskState.value
  if (st) {
    try {
      await window.api.masksClear([st.maskPath, ...(st.initPath ? [st.initPath] : [])])
    } catch {
      /* ignore */
    }
  }
  maskState.value = null
  toast('Mask cleared', 'info')
}

// A mask is specific to its session and to a diffusion type that allows
// inpainting — drop the sticky state when either changes. Files are
// ephemeral (data/tmp/masks is wiped at launch), so no deletion is needed.
watch(allowInpainting, (v) => {
  if (!v) maskState.value = null
})
watch(
  () => sessionsStore.activeId,
  () => {
    maskState.value = null
    paintState.value = null
  }
)

// ---------- paint tool ----------
/** Sticky composer paint state — the merged background+strokes image saved by
 *  the Paint dialog. Paths only, never data URLs (the image is re-resolved
 *  via imageFromPath when the dialog reopens). Sticky until cleared: once
 *  saved, the painted image routes into --init-img or the first --ref-image
 *  on every Send, per the target decided at save time. Mutually exclusive
 *  with the inpaint/outpaint mask state via the switch-guard. */
interface ComposerPaintState {
  paintPath: string
  /** how the painted image is routed: 'init' → the --init-img slot (wins
   *  over the previous-image chaining and user-picked inputs), 'reference' →
   *  the first --ref-image slot (the original first ref is replaced) */
  target: 'init' | 'reference'
  /** where the background came from — 'previous' suppresses the previous-
   *  image chaining on sends (the painted image supersedes it) */
  source: 'ref' | 'input' | 'previous'
  /** the merged image's natural size — informational (composer chip) */
  width: number
  height: number
}
const paintState = ref<ComposerPaintState | null>(null)
const paintOpen = ref(false)
const paintBg = ref('')
// The background's source, captured at open time — the routing target is
// derived from it at save time (the dialog is modal, so the composer cannot
// change in between).
const paintSource = ref<'ref' | 'input' | 'previous'>('ref')

// Button gating: NOT allow_inpainting (paint is not a mask feature) — the
// same background rule as the mask dialogs applies (first attached image /
// previous image when ticked). An active paint state keeps the button
// enabled for reopen/clear even when no fresh background is available
// (reopening shows the SAVED merged image).
const paintDisabled = computed(
  () =>
    busy.value ||
    !sessionsStore.activeId ||
    (!maskBackgroundAvailable.value && !paintState.value)
)
const paintTitle = computed(() => {
  const p = paintState.value
  if (p) {
    return `Painted image active — ${p.width}×${p.height} · ${p.target === 'init' ? 'as input' : 'as first reference'} — click to edit`
  }
  return 'Paint — paint onto an image and use it as input or reference'
})

/** Whether opening `target` would discard ANOTHER tool's active state (the
 *  composer's image-editing tools — inpaint, outpaint, paint — are mutually
 *  exclusive). Re-opening a tool's own state is never a conflict. */
function switchConflict(target: 'inpaint' | 'outpaint' | 'paint'): boolean {
  const m = maskState.value
  const p = paintState.value
  if (target === 'paint') return !!(m || p)
  return !!(p || (m && m.kind !== target))
}

/** Human label of whichever tool state is active (for the guard message). */
function activeStateLabel(): string {
  const m = maskState.value
  if (m) return m.kind === 'inpaint' ? 'an inpaint mask' : 'an outpaint mask'
  return 'a painted image'
}

/** Delete the saved files of whichever tool states are active and drop them.
 *  Only one can be set (mutual exclusion), but both are cleared defensively.
 *  Mirrors onMaskClear: explicit, user-confirmed cleanup deletes the files;
 *  the passive watchers only null the state (the launch wipe covers
 *  leftovers). */
async function clearActiveToolStates(): Promise<void> {
  const m = maskState.value
  if (m) {
    try {
      await window.api.masksClear([m.maskPath, ...(m.initPath ? [m.initPath] : [])])
    } catch {
      /* cleanup failure is non-fatal — the launch wipe covers leftovers */
    }
    maskState.value = null
  }
  const p = paintState.value
  if (p) {
    try {
      await window.api.masksClear([p.paintPath])
    } catch {
      /* ignore */
    }
    paintState.value = null
  }
}

/** The switch-guard: opening one image-editing tool while another tool's
 *  state is active asks first (in-app confirm dialog — never a native one)
 *  and clears the saved mask / painted image on confirmation. Returns false
 *  when the user cancels; the caller must then abort the open. */
async function confirmToolSwitch(target: 'inpaint' | 'outpaint' | 'paint'): Promise<boolean> {
  if (!switchConflict(target)) return true
  const label = activeStateLabel()
  const targetLabel =
    target === 'inpaint' ? 'Inpaint' : target === 'outpaint' ? 'Outpaint' : 'Paint'
  const ok = await confirm(
    `${label.charAt(0).toUpperCase()}${label.slice(1)} is active. Switching to ${targetLabel} will clear it.`,
    { confirmLabel: 'Switch and clear' }
  )
  if (!ok) return false
  await clearActiveToolStates()
  return true
}

async function openPaint(): Promise<void> {
  if (paintOpen.value) return
  // Reopen shows the SAVED merged image (the strokes are baked into it —
  // iterative editing); a fresh open takes the same precedence as the mask
  // dialogs. Resolving the background BEFORE the guard guarantees a
  // confirmed switch can never clear the old state and then open nothing.
  const active = paintState.value
  const bgPath =
    active?.paintPath ??
    refImages.value[0] ??
    inputImages.value[0] ??
    (usePrevious.value ? sessionsStore.lastGeneratedImage : undefined)
  if (!bgPath) return
  if (!(await confirmToolSwitch('paint'))) return
  const bg = await window.api.imageFromPath(bgPath)
  if (!bg) {
    toast('The background image no longer exists', 'error')
    return
  }
  paintBg.value = bg
  paintSource.value = active
    ? active.source
    : refImages.value.length
      ? 'ref'
      : inputImages.value.length
        ? 'input'
        : 'previous'
  paintOpen.value = true
}

/** Paint save: clean the previous paint state's file, derive the routing
 *  target from the background's source (captured at open time — the dialog
 *  is modal, so the composer cannot change in between), store the sticky
 *  state, and set the session's sampling strength override to 1.0 (exactly
 *  like applyMaskSave — the Session Sampling dialog shows and controls it). */
async function onPaintSave(p: {
  paintPath: string
  width: number
  height: number
}): Promise<void> {
  const old = paintState.value
  if (old) {
    try {
      await window.api.masksClear([old.paintPath])
    } catch {
      /* cleanup failure is non-fatal — the launch wipe covers leftovers */
    }
  }
  // previousMode's 'input' maps to the request's 'init' target (the dropdown
  // label and the CLI flag name differ; the routing slot is the same).
  const target: 'init' | 'reference' =
    paintSource.value === 'ref'
      ? 'reference'
      : paintSource.value === 'input'
        ? 'init'
        : previousMode.value === 'input'
          ? 'init'
          : 'reference'
  paintState.value = {
    paintPath: p.paintPath,
    target,
    source: paintSource.value,
    width: p.width,
    height: p.height
  }
  const id = sessionsStore.activeId
  if (id) {
    const prev = sessionsStore.active?.inputs?.sampling ?? {}
    try {
      await sessionsStore.setInputs(id, { sampling: { ...prev, strength: 1.0 } })
    } catch (err) {
      console.warn('[paint] saving strength override failed:', (err as Error)?.message ?? err)
    }
  }
  toast(
    target === 'init'
      ? 'Painted image saved — used as the input image on every Send until cleared'
      : 'Painted image saved — used as the first reference on every Send until cleared',
    'ok'
  )
  paintOpen.value = false
}

/** Clear from inside the Paint dialog: delete the saved paint file and drop
 *  the sticky state; the dialog stays up with a wiped canvas for fresh
 *  painting (no-op when nothing was saved yet). */
async function onPaintClear(): Promise<void> {
  const st = paintState.value
  if (st) {
    try {
      await window.api.masksClear([st.paintPath])
    } catch {
      /* ignore */
    }
    paintState.value = null
  }
}

// A paint state is specific to its session and to a diffusion type whose
// channel config still allows its target — drop the sticky state when either
// changes. Files are ephemeral (data/tmp/masks is wiped at launch), so no
// deletion is needed (same as the mask watchers).
watch([allowRef, allowInput], ([refOk, inputOk]) => {
  const p = paintState.value
  if (!p) return
  if ((p.target === 'reference' && !refOk) || (p.target === 'init' && !inputOk)) {
    paintState.value = null
  }
})
// `allow_painting` turning off drops the state too — the button disappears
// with it, so no orphan state can keep riding sends invisibly (same shape as
// the allowInpainting watcher above).
watch(allowPainting, (v) => {
  if (!v) paintState.value = null
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
  // persistInputs). The provider rides along so a reload re-resolves the
  // SAME variant when two same-family entries share a basename
  // (model-collision-hardening plan §6).
  persistInputs(sessionsStore.activeId, {
    model: e.name,
    // The NEW session key: the model's family (was `diffusionType`).
    family: e.diffusionType,
    // The hub.json diffusion entry `name` (e.g. comfy_org_boogu_image) — the
    // precise hub-config lookup key when a family maps to several entries.
    // hubEntryNameFor derives it from the fresh hub config while the cached
    // catalog predates the `hubName` stamp.
    diffusionName: hubEntryNameFor(e),
    modelProvider: e.provider
  })
}

const installedModels = ref<Partial<Record<ModelType, Set<string>>>>({})
async function refreshInstalled(): Promise<void> {
  for (const t of [
    'diffusion',
    'encoder',
    'vae',
    'vision',
    'tokenizer',
    'audio_encoder',
    'audio_vae',
    'latent_upscaler'
  ] as ModelType[]) {
    const files = await window.api.modelsList(t)
    installedModels.value[t] = new Set(files.map((f) => f.name))
  }
}
function isInstalled(e: CatalogEntry): boolean {
  // Permissive basename compare (model-collision-hardening plan §6): slashed
  // catalog names match their on-disk basename after the manager's
  // basename-normalized storage, and extra row metadata never invalidates a
  // legacy file — partially migrated libraries don't flip to "Not
  // Downloaded". Two catalog entries sharing a basename light up together —
  // they DO share the on-disk file; accepted.
  return installedModels.value[e.type]?.has(baseName(e.name)) ?? false
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
 * All bundle members of a catalog entry (WAN MoE `groupId` rows): the cached
 * catalog entries sharing its type/family/groupId — just `[e]` when the entry
 * carries no groupId (a plain single-file model). Mirrors
 * `catalogBundleForUrl()` in hub.ts (main) so the renderer's installed check
 * covers EVERY file of the selected catalog item: a MoE pair is not optional —
 * gen:start fails on a missing high-noise companion, and the main-side bundle
 * fan-out in downloadViaSource only runs once a download actually starts
 * (an already-installed primary short-circuits before it).
 */
function bundleMembers(e: CatalogEntry): CatalogEntry[] {
  if (!e.groupId) return [e]
  return (appStore.catalog?.entries ?? []).filter(
    (x) => x.type === e.type && x.diffusionType === e.diffusionType && x.groupId === e.groupId
  )
}
/**
 * Ensure a catalog entry — and every bundle member it groups (MoE pairs) — is
 * on disk. No-op per member when already installed; otherwise starts (or
 * re-joins) a background download and resolves when it completes.
 */
async function ensureDownloaded(e: CatalogEntry): Promise<void> {
  for (const m of bundleMembers(e)) await ensureSingleDownloaded(m)
}
async function ensureSingleDownloaded(e: CatalogEntry): Promise<void> {
  if (isInstalled(e)) {
    // The file may be a truncated/corrupted download — verify its size
    // against the server before trusting it.
    // Verify against the entry's exact family/provider slot (the resolution
    // gen:start will use) instead of a basename-global guess.
    const v = await window.api.modelsVerify(e.type, e.name, e.url, e.provider, e.diffusionType)
    if (!v.ok) {
      // `exists` distinguishes a truncated file from one that is simply not
      // installed at this model's own (family, provider) slot — the strict
      // per-family resolution makes the latter the common repair case.
      toast(
        v.exists
          ? `${e.name} is incomplete (${v.actual} of ${v.expected} bytes) — re-downloading`
          : `${e.name} is not installed for this model's configuration — downloading`,
        'info',
        8000
      )
      await settingsStore.removeModel(e.type, e.name, e.provider, e.diffusionType, e.url)
    } else {
      return
    }
  }
  const key = `${e.type}:${e.url}`
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      try {
        await settingsStore.downloadModel(e.type, e.url, e.provider, false, e.diffusionType)
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
      tokenizerEntry.value = null
      audioEncoderEntry.value = null
      audioVaeEntry.value = null
      latentUpscalerEntry.value = null
      resolution.value = null
      isCustomResolution.value = false
      return
    }
    // Companion-model families: the hub entry's `requires` blocks route the
    // companion resolution to a DIFFERENT diffusion family (wan2_2_t2v uses
    // the wan2_1 VAE + encoder; S2V adds the wan2_2 audio encoder). The
    // companion arrays are NEVER empty — an undeclared kind falls back to the
    // diffusion type itself under the kind's default CLI flag.
    // The hub entry `name` pins the EXACT hub entry when a family maps to
    // several entries (multiple providers). hubEntryNameFor prefers the
    // catalog stamp and derives from the fresh hub config while the cache
    // predates it.
    const hubName = entry ? hubEntryNameFor(entry) : undefined
    const vaeFamily = requiredCompanionsFor(dt, 'vae', hubName)[0].from
    const encComps = requiredCompanionsFor(dt, 'encoder', hubName)
    const encFamily = encComps[0].from
    const audFamily = requiredCompanionsFor(dt, 'audio_encoder', hubName)[0].from
    const tokenizerFamily = requiredCompanionsFor(dt, 'tokenizer', hubName)[0].from
    const audioVaeFamily = requiredCompanionsFor(dt, 'audio_vae', hubName)[0].from
    const latentUpscalerFamily = requiredCompanionsFor(dt, 'latent_upscaler', hubName)[0].from
    const st = await window.api.settingsGet()
    // Re-entrancy token: restore triggers this watcher on every session
    // switch, so two overlapping async runs — rapid A→B→C switching — could
    // otherwise interleave their post-await assignments and cross-write one
    // session's derived state into another. Bail when the selection changed
    // across the await; a newer run owns the composer now. (Pre-existing
    // race, previously near-impossible to hit by hand; restore makes it
    // reachable.)
    if (modelEntry.value !== entry) return
    // The default-VAE settings key is the RESOLVED family, so the wan2_1 VAE
    // selected for wan2_2_t2v is shared with wan2_1 sessions.
    const vaeName = st.defaultVae?.[vaeFamily]
    // The VAE configured for the resolved family (from hub.json) is the source of truth
    const vaeCfg = appStore.configs?.hub.repo.vae[vaeFamily]
    const defaultVaeName =
      typeof vaeCfg === 'string'
        ? vaeCfg.split('/').pop() ?? vaeCfg
        : (vaeCfg?.default.split('/').pop() ?? vaeCfg?.default ?? '')
    vaeEntry.value =
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === vaeFamily && e.name === vaeName) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === vaeFamily && e.name === defaultVaeName) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === vaeFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vae' && e.diffusionType === vaeFamily) ??
      null
    // Encoder bundle (SD3.5-style `defaults[]`) — the bundle check must run
    // BEFORE the single-file resolution chain: after a rescan the catalog
    // carries `isDefault` bundle entries, so if the chain ran first its
    // `isDefault` fallback would resolve `encoderEntry` to the first bundle
    // file (clip_g) and the legacy flow would send `--llm clip_g.safetensors`.
    // Assignment (not conditional clearing) covers bundle→single,
    // single→bundle, bundle→bundle and model-deselection without enumerating
    // transitions, so a stale bundle can never leak across model switches.
    // Array-form `requires.encoder` (from hub.json, e.g. hunyuan_video_1_5's
    // qwen2_5_vl + byt5_small each from a different family) is resolved from
    // the FRESH config and takes precedence over the SD3.5 `defaults[]` bundle
    // and the single-file chain: each item carries its own `useAs` and resolves
    // from its own `from` family, so it must be surfaced before the legacy
    // bundle/single-file flow.
    const requiredBundle = requiredEncoderBundle(dt, hubName)
    const bundle = requiredBundle.length ? requiredBundle : resolveEncoderBundle(encFamily)
    encoderBundle.value = bundle
    if (bundle.length) {
      encoderEntry.value = null
    } else {
      // Resolution order: user-configured default (settings, keyed by the
      // resolved family) > hub.json `default` (a repo-relative path — match
      // catalog entries by file name so a stale cached catalog without
      // isDefault flags still resolves correctly).
      const userEncoderName = st.defaultEncoder?.[encFamily]
      const defaultEncoder = appStore.configs?.hub.repo.encoder[encFamily]?.default ?? ''
      const defaultEncoderName = defaultEncoder.split('/').pop() ?? defaultEncoder
      encoderEntry.value =
        (userEncoderName
          ? (appStore.catalog?.entries ?? []).find(
              (e) => e.type === 'encoder' && e.diffusionType === encFamily && e.name === userEncoderName
            )
          : undefined) ??
        (appStore.catalog?.entries ?? []).find(
          (e) => e.type === 'encoder' && e.diffusionType === encFamily && (e.name === defaultEncoder || e.name === defaultEncoderName)
        ) ??
        (appStore.catalog?.entries ?? []).find((e) => e.type === 'encoder' && e.diffusionType === encFamily && e.isDefault) ??
        (appStore.catalog?.entries ?? []).find((e) => e.type === 'encoder' && e.diffusionType === encFamily) ??
        null
      // Entry-level `use_as` (the wan umt5-xxl encoder → `--t5xxl`): promote
      // the single-file encoder into a one-element bundle so the request
      // takes the bundle path and buildArgs emits `--<use_as>` instead of
      // the legacy `--llm`.
      if (encoderEntry.value?.useAs) {
        const single = encoderEntry.value
        encoderBundle.value = [{ ...single, useAs: single.useAs! }]
        encoderEntry.value = null
      }
    }
    // Vision (mmproj) model — only present for diffusion_types that declare a
    // `vision` dependency in hub.json (e.g. boogu_image). The family it resolves
    // from is `requiredCompanionsFor(dt, 'vision')[0].from` (the
    // `requires.vision.from` family when present, else dt itself) — exactly like
    // the VAE resolution above.
    const visionFamily = requiredCompanionsFor(dt, 'vision')[0].from
    const userVisionName = st.defaultVision?.[visionFamily]
    // `vision` is optional in HubConfig — absent when the diffusion type declares no vision dependency.
    const defaultVision = appStore.configs?.hub.repo.vision?.[visionFamily]?.default ?? ''
    const defaultVisionName = defaultVision.split('/').pop() ?? defaultVision
    visionEntry.value =
      (userVisionName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'vision' && e.diffusionType === visionFamily && e.name === userVisionName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'vision' && e.diffusionType === visionFamily && (e.name === defaultVision || e.name === defaultVisionName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vision' && e.diffusionType === visionFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'vision' && e.diffusionType === visionFamily) ??
      null
    // Tokenizer — only present for diffusion_types that declare a `tokenizer`
    // dependency in hub.json (e.g. moss_image). Resolution mirrors vision:
    // user-configured default > hub.json `default` (matched by full path AND
    // basename for stale cached catalogs) > the catalog's `isDefault` flag >
    // any entry > null.
    const userTokenizerName = st.defaultTokenizer?.[tokenizerFamily]
    // `tokenizer` is optional in HubConfig — absent when the diffusion type declares no tokenizer dependency.
    const defaultTokenizer = appStore.configs?.hub.repo.tokenizer?.[tokenizerFamily]?.default ?? ''
    const defaultTokenizerName = defaultTokenizer.split('/').pop() ?? defaultTokenizer
    tokenizerEntry.value =
      (userTokenizerName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'tokenizer' && e.diffusionType === tokenizerFamily && e.name === userTokenizerName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'tokenizer' && e.diffusionType === tokenizerFamily && (e.name === defaultTokenizer || e.name === defaultTokenizerName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'tokenizer' && e.diffusionType === tokenizerFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'tokenizer' && e.diffusionType === tokenizerFamily) ??
      null
    // Audio encoder (wav2vec2 — Wan2.2 S2V only): resolved from the REQUIRED
    // family (hub.json repo.audio_encoder is keyed by the wan2_2 family and
    // reached through `requires.audio_encoder.from`). Types without a
    // required audio encoder resolve to null — no entry, no flag.
    const userAudioEncoderName = st.defaultAudioEncoder?.[audFamily]
    const defaultAudioEncoder = appStore.configs?.hub.repo.audio_encoder?.[audFamily]?.default ?? ''
    const defaultAudioEncoderName = defaultAudioEncoder.split('/').pop() ?? defaultAudioEncoder
    audioEncoderEntry.value =
      (userAudioEncoderName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'audio_encoder' && e.diffusionType === audFamily && e.name === userAudioEncoderName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'audio_encoder' && e.diffusionType === audFamily && (e.name === defaultAudioEncoder || e.name === defaultAudioEncoderName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'audio_encoder' && e.diffusionType === audFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'audio_encoder' && e.diffusionType === audFamily) ??
      null
    // Audio VAE (LTX 2.5's audio track) and latent upscaler (LTX 2.5 hires
    // fix) — resolved from the companion family (the hub entry's
    // `requires.audio_vae` / `requires.latent_upscaler.from` when declared,
    // else the diffusion type itself; both hub sections are family-keyed
    // single-default-file entries). Types whose hub config declares neither
    // resolve to null — no entry, no flag.
    const userAudioVaeName = st.defaultAudioVae?.[audioVaeFamily]
    const defaultAudioVae = appStore.configs?.hub.repo.audio_vae?.[audioVaeFamily]?.default ?? ''
    const defaultAudioVaeName = defaultAudioVae.split('/').pop() ?? defaultAudioVae
    audioVaeEntry.value =
      (userAudioVaeName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'audio_vae' && e.diffusionType === audioVaeFamily && e.name === userAudioVaeName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'audio_vae' && e.diffusionType === audioVaeFamily && (e.name === defaultAudioVae || e.name === defaultAudioVaeName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'audio_vae' && e.diffusionType === audioVaeFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'audio_vae' && e.diffusionType === audioVaeFamily) ??
      null
    const userLatentUpscalerName = st.defaultLatentUpscaler?.[latentUpscalerFamily]
    const defaultLatentUpscaler = appStore.configs?.hub.repo.latent_upscaler?.[latentUpscalerFamily]?.default ?? ''
    const defaultLatentUpscalerName = defaultLatentUpscaler.split('/').pop() ?? defaultLatentUpscaler
    latentUpscalerEntry.value =
      (userLatentUpscalerName
        ? (appStore.catalog?.entries ?? []).find(
            (e) => e.type === 'latent_upscaler' && e.diffusionType === latentUpscalerFamily && e.name === userLatentUpscalerName
          )
        : undefined) ??
      (appStore.catalog?.entries ?? []).find(
        (e) => e.type === 'latent_upscaler' && e.diffusionType === latentUpscalerFamily && (e.name === defaultLatentUpscaler || e.name === defaultLatentUpscalerName)
      ) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'latent_upscaler' && e.diffusionType === latentUpscalerFamily && e.isDefault) ??
      (appStore.catalog?.entries ?? []).find((e) => e.type === 'latent_upscaler' && e.diffusionType === latentUpscalerFamily) ??
      null
    // Restore support: when a saved resolution is pending, prefer it — the
    // dimension-matched preset (keeps canonical preset names) when one
    // matches, else the saved entry VERBATIM (a custom selection is not in
    // the list and must survive) — over the first entry, then clear the
    // one-shot marker so the resolution watchers resume normal operation.
    // This relies on this watcher being registered before the `resolutions`
    // watcher so the restored resolution survives the list guard (which
    // skips while the marker is set) — keep that order. Every assignment
    // here also refreshes isCustomResolution so the list guard knows whether
    // the current value is an intentional unlisted custom size.
    const saved = pendingRestoreResolution.value
    const matched = saved
      ? resolutions.value.find((x) => x.width === saved.width && x.height === saved.height)
      : undefined
    resolution.value = matched ?? saved ?? resolutions.value[0] ?? null
    isCustomResolution.value = !matchesPresetDimensions(resolution.value, resolutions.value)
    pendingRestoreResolution.value = null
    // Auto-download the selected diffusion model and its VAE / text encoder /
    // vision / tokenizer dependencies in the background. Swallow rejections (a
    // paused or canceled download rejects) so a background attempt never
    // becomes an unhandled promise rejection — the error toast already
    // surfaces it.
    if (modelEntry.value) void ensureDownloaded(modelEntry.value).catch(() => {})
    if (vaeEntry.value) void ensureDownloaded(vaeEntry.value).catch(() => {})
    if (encoderEntry.value) void ensureDownloaded(encoderEntry.value).catch(() => {})
    // each bundle file gets its own progress row for free (`depDownloads`
    // keys by `${type}:${url}`)
    for (const e of encoderBundle.value) void ensureDownloaded(e).catch(() => {})
    if (visionEntry.value) void ensureDownloaded(visionEntry.value).catch(() => {})
    if (tokenizerEntry.value) void ensureDownloaded(tokenizerEntry.value).catch(() => {})
    if (audioEncoderEntry.value) void ensureDownloaded(audioEncoderEntry.value).catch(() => {})
    // Both LTX companions are REGISTERED family dependencies — they download
    // with the per-family bundle on model selection (exactly like the audio
    // encoder), NOT gated on the Upscale checkbox (the checkbox gates only
    // the flag emission).
    if (audioVaeEntry.value) void ensureDownloaded(audioVaeEntry.value).catch(() => {})
    if (latentUpscalerEntry.value) void ensureDownloaded(latentUpscalerEntry.value).catch(() => {})
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
  // A user-picked custom resolution is intentionally unlisted — never snap it
  // to the first preset on list changes (catalog rescans). Model switches are
  // handled by the model watcher, which re-seeds a preset default and clears
  // the flag.
  if (isCustomResolution.value) return
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

    // The stored model NAME is the primary key — the saved family (the NEW
    // `family` key, falling back to the legacy `diffusionType`) and provider
    // are NARROWING hints. A family that no longer matches (hub rename, a
    // retargeted entry) degrades to the name-only match instead of failing
    // the restore; legacy sessions without modelProvider fall back to the
    // first name match — the pre-change behavior (plan §6/§9 item 14).
    const savedFamily = inputs.family ?? inputs.diffusionType
    const nameMatches = catalog.entries.filter(
      (e) => e.type === 'diffusion' && e.name === inputs.model
    )
    const familyMatches = savedFamily
      ? nameMatches.filter((e) => e.diffusionType === savedFamily)
      : []
    const resolved =
      (inputs.modelProvider
        ? familyMatches.find((e) => e.provider === inputs.modelProvider) ??
          nameMatches.find((e) => e.provider === inputs.modelProvider)
        : undefined) ??
      familyMatches[0] ??
      nameMatches[0] ??
      null

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
      const matched = saved
        ? resolutions.value.find((x) => x.width === saved.width && x.height === saved.height)
        : undefined
      resolution.value = matched ?? saved ?? resolutions.value[0] ?? null
      isCustomResolution.value = !matchesPresetDimensions(resolution.value, resolutions.value)
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

/**
 * Attach the picked paths to a composer channel. Shared tail of addRefs /
 * addInputs: the cap checks and dedupe run over the FINAL paths (after the
 * optional resize/crop pass), so a processed file — always a fresh unique
 * path — still lands under the same channel caps.
 */
function attachPicked(paths: string[], channel: 'reference' | 'input'): void {
  for (const p of paths) {
    if (channel === 'reference') {
      if (refImages.value.length >= maxRef.value) {
        toast(`Maximum of ${maxRef.value} reference images`, 'error')
        break
      }
      if (!refImages.value.includes(p)) refImages.value.push(p)
    } else {
      if (inputImages.value.length >= maxInput.value) {
        toast(`Maximum of ${maxInput.value} input images`, 'error')
        break
      }
      if (!inputImages.value.includes(p)) inputImages.value.push(p)
    }
  }
}

/**
 * Offer the non-destructive resize/crop editor for freshly picked images
 * (plans/image-resize-crop.md). The confirm asks ONCE for the whole selection;
 * the editor processes the queue one-by-one and resolves with the final path
 * list (null = canceled → attach nothing).
 */
async function attachWithOptionalEdit(picked: string[], channel: 'reference' | 'input'): Promise<void> {
  if (!picked.length) return
  if (
    await confirm('Resize or crop the selected image(s) before adding?', {
      confirmLabel: 'Edit',
      cancelLabel: 'Add as-is'
    })
  ) {
    const final = await resizeStore.openEditor(
      picked,
      channel,
      modelEntry.value?.diffusionType ?? null
    )
    if (final === null) return
    attachPicked(final, channel)
  } else {
    attachPicked(picked, channel)
  }
}

async function addRefs(): Promise<void> {
  await attachWithOptionalEdit(await window.api.pickImages(), 'reference')
}
function removeRef(p: string): void {
  refImages.value = refImages.value.filter((x) => x !== p)
}

async function addInputs(): Promise<void> {
  await attachWithOptionalEdit(await window.api.pickImages(), 'input')
}
function removeInput(p: string): void {
  inputImages.value = inputImages.value.filter((x) => x !== p)
}

// ---------- video-era channels (WAN) ----------
/** File-name tail for the non-image channel chips (audio / control frames). */
function mediaBaseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
// Driving audio (--audio, Wan2.2 S2V) — picked via the channel `accepts`
// globs through the parameterized pickMedia invoke.
async function addAudio(): Promise<void> {
  const picked = await window.api.pickMedia([{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac'] }])
  if (picked.length) audioPath.value = picked[0]
}
function clearAudio(): void {
  audioPath.value = ''
}
// Control video (--control-video, VACE) — sd-cli wants a frames DIRECTORY,
// so this opens the existing directory picker.
async function addControlVideo(): Promise<void> {
  const dir = await window.api.pickDirectory()
  if (dir) controlVideoPath.value = dir
}
function clearControlVideo(): void {
  controlVideoPath.value = ''
}
// End image (--end-img, FLF2V) — dormant while every entry has show:false.
async function addEndImage(): Promise<void> {
  const picked = await window.api.pickMedia([{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }])
  if (picked.length) endImagePath.value = picked[0]
}
function clearEndImage(): void {
  endImagePath.value = ''
}
// ---------- repeatable reference channels (MiniMax-H3 Ref2VA) ----------
// Reference audio (--ref-audio, repeatable standalone WAV reference) — append
// per pick under the channel `max` cap (the pickMedia flow is single-select;
// the repeatable flag means the user picks repeatedly).
async function addAudioRef(): Promise<void> {
  const picked = await window.api.pickMedia([{ name: 'Audio', extensions: ['wav'] }])
  for (const p of picked) {
    if (audioRefPaths.value.length >= maxAudioRef.value) {
      toast(`Maximum of ${maxAudioRef.value} reference audio file${maxAudioRef.value === 1 ? '' : 's'}`, 'error')
      break
    }
    if (!audioRefPaths.value.includes(p)) audioRefPaths.value.push(p)
  }
}
function removeAudioRef(p: string): void {
  audioRefPaths.value = audioRefPaths.value.filter((x) => x !== p)
}
// Reference video (--ref-video, repeatable) — sd-cli wants a reference video
// FRAMES DIRECTORY at 24 fps, so this opens the directory picker (NOT a media
// file picker).
async function addVideoRef(): Promise<void> {
  const dir = await window.api.pickDirectory()
  if (!dir) return
  if (videoRefPaths.value.includes(dir)) return
  if (videoRefPaths.value.length >= maxVideoRef.value) {
    toast(`Maximum of ${maxVideoRef.value} reference video director${maxVideoRef.value === 1 ? 'y' : 'ies'}`, 'error')
    return
  }
  videoRefPaths.value.push(dir)
}
function removeVideoRef(p: string): void {
  videoRefPaths.value = videoRefPaths.value.filter((x) => x !== p)
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
  if (!e.dataTransfer) return
  const files = Array.from(e.dataTransfer.files)
  if (!files.length) return
  if (!refsEnabled.value && !inputsEnabled.value) {
    toast('This model does not accept images', 'error')
    return
  }
  // Ask the user which channel the dropped images belong to; the files are
  // held in the modal state until the choice lands (dismiss discards them).
  dropAsk.value = { files }
}
// Dropped-image mode question state — files stay here (never pushed into
// either list) until the user picks a channel, so the caps are checked
// after the choice, not before.
const dropAsk = ref<{ files: File[] } | null>(null)
async function settleDrop(mode: 'input' | 'reference'): Promise<void> {
  const ask = dropAsk.value
  dropAsk.value = null
  if (!ask) return
  for (const file of ask.files) {
    if (!file.type.startsWith('image/')) {
      toast(`"${file.name}" is not an image`, 'error')
      continue
    }
    const path = (file as File & { path?: string }).path
    if (!path) {
      toast(`Cannot use "${file.name}" as an image`, 'error')
      continue
    }
    if (mode === 'reference') {
      if (refImages.value.length >= maxRef.value) {
        toast(`Maximum of ${maxRef.value} reference images`, 'error')
        break
      }
      if (!refImages.value.includes(path)) refImages.value.push(path)
    } else {
      if (inputImages.value.length >= maxInput.value) {
        toast(`Maximum of ${maxInput.value} input images`, 'error')
        break
      }
      if (!inputImages.value.includes(path)) inputImages.value.push(path)
    }
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
    const inputs = [...inputImages.value]
    pendingPrompt.value = text
    pendingRefs.value = [...refs, ...inputs]
    busy.value = true
    progress.value = null
    prompt.value = ''
    refImages.value = []
    inputImages.value = []
    // Ensure the diffusion model and the VAE / text encoder / vision / tokenizer
    // deps are on disk (and complete) before spawning. Waits for an in-flight
    // download, or starts one if none is running. On the bundle path
    // `encoderEntry` is null, so the bundle entries must be iterated here too or
    // the text encoders would silently be skipped.
    for (const e of [
      modelEntry.value,
      vaeEntry.value,
      encoderEntry.value,
      ...encoderBundle.value,
      visionEntry.value,
      tokenizerEntry.value,
      audioEncoderEntry.value,
      // Registered family dependencies — awaited UNCONDITIONALLY (a failed
      // download fails the Send loudly, same as the VAE/encoder).
      audioVaeEntry.value,
      latentUpscalerEntry.value
    ]) {
      if (!e) continue
      try {
        await ensureDownloaded(e)
      } catch (err) {
        prompt.value = text
        refImages.value = [...refs]
        inputImages.value = [...inputs]
        pendingPrompt.value = null
        pendingRefs.value = []
        busy.value = false
        toast((err as Error).message, 'error')
        return
      }
    }

    const s = sessionSampling.value
    // Belt-and-braces with the channel watchers: the previous image is chained
    // only when the user opted in AND the type's `use_previous_image` gate is
    // on AND at least one image channel is enabled. A paint state sourced from
    // the previous image supersedes it: chaining the raw previous image
    // alongside its painted replacement would duplicate the reference (As
    // Reference) or let the raw image steal the single init slot ahead of the
    // painted one (As Input — main unshifts it first). The checkbox itself is
    // left untouched; the suppression is per-send while the state is active.
    const chainPrevious =
      usePrevious.value &&
      allowPreviousImage.value &&
      (allowRef.value || allowInput.value) &&
      paintState.value?.source !== 'previous'
    const req: GenerationRequest = {
      // A session was created above when none was active, so the id is set.
      sessionId: sessionsStore.activeId!,
      prompt: text,
      model: modelEntry.value.name,
      diffusionType: modelEntry.value.diffusionType,
      // Provider disambiguates a basename collision across provider folders
      // within one family — main resolves the diffusion model through the
      // family/provider-scoped pathFor chain with it (plan §3.6).
      modelProvider: modelEntry.value.provider,
      // The hub.json diffusion entry `name` of the selected model — main
      // resolves the entry's hub configuration (requires block…) precisely
      // when a family maps to several entries. hubEntryNameFor derives it
      // from the fresh hub config while the catalog cache predates the stamp.
      ...(hubEntryNameFor(modelEntry.value) ? { diffusionName: hubEntryNameFor(modelEntry.value) } : {}),
      vae: vaeEntry.value?.name,
      // Provider disambiguates a basename collision across provider folders
      // (e.g. sd3_5's `diffusion_pytorch_model.safetensors` exists under both
      // black_forest_labs and huaweilin). Without this main resolves by
      // basename and picks whichever folder sorts first.
      vaeProvider: vaeEntry.value?.provider,
      // Bundle wins at spawn time: gen:start ignores `encoder` when `encoders`
      // is non-empty. On the bundle path `encoder` is omitted entirely. A
      // single-file encoder with an entry-level `use_as` (wan umt5-xxl) is
      // promoted into a one-element bundle in the model watcher, so it takes
      // this path and emits `--t5xxl` instead of `--llm`.
      ...(encoderBundle.value.length
        ? { encoders: encoderBundle.value.map((e) => ({ name: e.name, useAs: e.useAs, provider: e.provider })) }
        : { encoder: encoderEntry.value?.name, encoderProvider: encoderEntry.value?.provider }),
      vision: visionEntry.value?.name,
      tokenizer: tokenizerEntry.value?.name,
      // Wan2.2 S2V audio encoder — resolved from the required family; the
      // name rides the request, main resolves the path.
      ...(audioEncoderEntry.value ? { audioEncoder: audioEncoderEntry.value.name } : {}),
      // LTX 2.5 companions — sent whenever resolved; main gates the flag
      // emission on the merged `upscale` (the audio VAE emits
      // unconditionally). Provider disambiguates a basename collision across
      // provider folders.
      ...(audioVaeEntry.value
        ? { audioVae: audioVaeEntry.value.name, audioVaeProvider: audioVaeEntry.value.provider }
        : {}),
      ...(latentUpscalerEntry.value
        ? { latentUpscaler: latentUpscalerEntry.value.name, latentUpscalerProvider: latentUpscalerEntry.value.provider }
        : {}),
      // The resolution selected in the chat panel always wins; per-session
      // width/height overrides are no longer supported.
      resolution:
        resolution.value
          ? { width: resolution.value.width, height: resolution.value.height }
          : { width: s?.width.default ?? 1024, height: s?.height.default ?? 1024 },
      referencePaths: [...refs],
      inputImagePaths: [...inputs],
      // Video-era channels (S2V audio / VACE control frames / FLF2V end
      // image) — main re-validates the paths and drops them for types whose
      // channel config forbids them.
      ...(audioPath.value ? { audioPath: audioPath.value } : {}),
      ...(controlVideoPath.value ? { controlVideoPath: controlVideoPath.value } : {}),
      ...(endImagePath.value ? { endImagePath: endImagePath.value } : {}),
      // Repeatable reference channels (--ref-audio / --ref-video, MiniMax-H3
      // Ref2VA) — main re-validates, dedupes and caps them the same way.
      ...(audioRefPaths.value.length ? { audioReferencePaths: [...audioRefPaths.value] } : {}),
      ...(videoRefPaths.value.length ? { videoReferencePaths: [...videoRefPaths.value] } : {}),
      usePrevious: chainPrevious,
      // omitted entirely when unchecked or disallowed — the request payload
      // carries no previous image unless the user explicitly opted in
      previousImagePath: chainPrevious ? sessionsStore.lastGeneratedImage : undefined,
      previousImageMode: chainPrevious ? previousMode.value : undefined,
      // Steps / cfg / sampler / strength: nullable — a null descriptor
      // default ("auto") must reach main AS NULL so buildArgs OMITS the flag
      // and sd-cli's own default applies (steps 20; cfg-scale 7.0;
      // sampling-method euler for Flux/SD3/Wan, euler_a otherwise; strength
      // 0.75). Never fall back to a hardcoded value here: it would override
      // the config's "auto" with an arbitrary constant.
      steps: s?.steps.default ?? null,
      cfg: s?.cfg.default ?? null,
      sampler: s?.sampler.default ?? null,
      // RAW merged value — a concrete string, the 'model-specific' sentinel, or
      // null. Main resolves the sentinel + the global fallback (§2.2);
      // pre-resolving here would erase the distinction between "picked
      // model-specific" and "no scheduler chosen".
      scheduler: s?.scheduler.default ?? undefined,
      // RAW merged value — a finite number (incl 0), '', or undefined. Main
      // resolves the global fallback + normalization; `??` (never `||`) keeps
      // 0 and '' intact.
      flowShift: s?.flow_shift.default ?? undefined,
      // Seed is resolved entirely by main (request value wins, then the
      // session override, then the settings override) — the renderer sends
      // nothing.
      negativePrompt: sessionNegative.value.trim() || undefined,
      // RAW merged value — a concrete string, or null. Main resolves the
      // global fallback; '' / null ⇒ no --model-args flag (sd-cli default).
      modelArgs: s?.model_args.default ?? undefined,
      strength: s?.strength.default ?? null
    }
    // Sticky mask: a saved mask rides on EVERY Send until cleared. The
    // renderer sends the exact background it drew on (initImagePath captured
    // at dialog time — main validates both paths exist). With Override
    // Resolution off the image-derived size replaces the dropdown value;
    // with it ticked the session's resolution dropdown value is sent
    // unchanged and sd-cli scales init + mask identically.
    const mask = maskState.value
    if (mask) {
      req.maskPath = mask.maskPath
      // The init image the mask was drawn on: outpaint → the padded
      // composition written by masksSave; inpaint → the background image
      // itself (it was never re-written, so `initPath` is undefined and the
      // background path captured at dialog time is the init image).
      req.initImagePath =
        mask.initPath ?? (mask.kind === 'inpaint' ? mask.backgroundPath : undefined)
      if (!mask.overrideResolution) {
        req.resolution = { width: mask.width, height: mask.height }
      }
    }
    // Sticky paint: a saved painted image rides on EVERY Send until cleared
    // or switched away. The routing target was decided at save time from the
    // background's source; main validates the path exists and applies the
    // channel gates.
    const paint = paintState.value
    if (paint) {
      req.paintImagePath = paint.paintPath
      req.paintTarget = paint.target
    }
    try {
      await window.api.genStart(req)
      // Seed the per-session busy state so the window between the IPC return
      // and the first 'running' event is covered even if the user switches
      // sessions in between (plans/session-switch-busy-state.md).
      genStore.markRunning(req.sessionId)
      // Main has persisted the messages by now — load them first so the optimistic
      // placeholders are replaced by the real ones, then drop the placeholders.
      await sessionsStore.refreshActive()
      pendingPrompt.value = null
      pendingRefs.value = []
    } catch (err) {
      prompt.value = text
      refImages.value = [...refs]
      inputImages.value = [...inputs]
      pendingPrompt.value = null
      pendingRefs.value = []
      // Re-mirror from the store instead of blindly clearing: a rejected send
      // (main's double-spawn guard) must not clear a busy state that is
      // genuinely still running for this session.
      const e = genStore.of(req.sessionId)
      busy.value = !!e
      converting.value = e?.status === 'converting'
      progress.value = e?.step != null ? { step: e.step, total: e.totalSteps ?? 0 } : null
      void sessionsStore.refreshActive()
      // A purged stale mask reference already got a native warning dialog
      // from main (which also pushed masks:invalidated) — don't double-toast.
      const msg = (err as Error)?.message ?? ''
      if (!msg.includes('purged')) toast(msg, 'error')
    }
  } finally {
    starting = false
  }
}

async function preview(): Promise<void> {
  if (!prompt.value.trim()) return
  if (!sessionsStore.activeId) { toast('No active session', 'error'); return }
  previewOpen.value = true
  previewError.value = ''
  previewCommand.value = ''
  // Build a GenerationRequest mirroring what generate() builds, then call
  // gen:preview to get the command line without spawning sd-cli.
  try {
    const s = sessionSampling.value
    const modelE = modelEntry.value
    if (!modelE) { previewError.value = 'No model selected'; return }
    const previewReq: GenerationRequest = {
      sessionId: sessionsStore.activeId,
      prompt: prompt.value,
      model: modelE.name,
      diffusionType: modelE.diffusionType,
      modelProvider: modelE.provider,
      ...(hubEntryNameFor(modelE) ? { diffusionName: hubEntryNameFor(modelE) } : {}),
      vae: vaeEntry.value?.name,
      vaeProvider: vaeEntry.value?.provider,
      ...(encoderBundle.value.length
        ? { encoders: encoderBundle.value.map((e) => ({ name: e.name, useAs: e.useAs, provider: e.provider })) }
        : { encoder: encoderEntry.value?.name, encoderProvider: encoderEntry.value?.provider }),
      vision: visionEntry.value?.name,
      tokenizer: tokenizerEntry.value?.name,
      ...(audioEncoderEntry.value ? { audioEncoder: audioEncoderEntry.value.name } : {}),
      ...(audioVaeEntry.value ? { audioVae: audioVaeEntry.value.name, audioVaeProvider: audioVaeEntry.value.provider } : {}),
      ...(latentUpscalerEntry.value ? { latentUpscaler: latentUpscalerEntry.value.name, latentUpscalerProvider: latentUpscalerEntry.value.provider } : {}),
      resolution: resolution.value ? { width: resolution.value.width, height: resolution.value.height } : { width: s?.width.default ?? 1024, height: s?.height.default ?? 1024 },
      referencePaths: [...refImages.value],
      inputImagePaths: [...inputImages.value],
      usePrevious: usePrevious.value,
      previousImageMode: previousMode.value,
      previousImagePath: usePrevious.value ? sessionsStore.lastGeneratedImage : undefined,
      steps: s?.steps.default ?? null,
      cfg: s?.cfg.default ?? null,
      sampler: s?.sampler.default ?? null,
      scheduler: s?.scheduler.default ?? undefined,
      flowShift: s?.flow_shift.default ?? undefined,
      negativePrompt: sessionNegative.value.trim() || undefined,
      modelArgs: s?.model_args.default ?? undefined,
      strength: s?.strength.default ?? null
    }
    const result = await window.api.genPreview(previewReq)
    previewCommand.value = result.command
  } catch (err) {
    previewError.value = (err as Error)?.message ?? String(err)
  }
}

function stop(): void {
  if (sessionsStore.activeId) void window.api.genStop(sessionsStore.activeId)
}

function copyPreview(): void {
  if (previewCommand.value) {
    navigator.clipboard.writeText(previewCommand.value).then(() => {
      toast('Command copied to clipboard', 'ok')
    }).catch(() => {
      toast('Failed to copy', 'error')
    })
  }
}

// ---------- prompt enhancer (LLM) ----------
// Icon-only Enhance button in the composer toolbar: rewrites the prompt
// through the configured llama.cpp model + system prompt. While an
// enhancement runs the button pulses and a second click CANCELS it
// (llm:stop — the Send→Stop pattern); on success the textarea content is
// replaced with the enhanced prompt; errors surface as toasts (including the
// "download the model in Settings → Language Models" hint main sends).
const enhancing = ref(false)
async function enhance(): Promise<void> {
  if (enhancing.value) {
    await window.api.llmStop()
    return
  }
  const text = prompt.value.trim()
  if (!text || busy.value) return
  enhancing.value = true
  try {
    const res = await window.api.llmEnhance(text)
    if (res.text) prompt.value = res.text
  } catch (err) {
    const msg = (err as Error)?.message ?? ''
    // The cancel path rejects with a sentinel the renderer recognizes —
    // not an error toast.
    if (msg !== 'Enhancement cancelled') toast(msg || 'Enhance failed', 'error')
  } finally {
    enhancing.value = false
  }
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
async function onSaveLora(draft: SessionLora | null): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { lora: draft })
  loraOpen.value = false
}
async function onSaveAdetailer(draft: AdetailerSettings): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { adetailer: draft })
  adetailerOpen.value = false
}
async function onSaveIpAdapter(draft: SessionIpAdapter): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { ipAdapter: draft })
  ipAdapterOpen.value = false
}
async function onSaveControlNet(draft: SessionControlNet | null): Promise<void> {
  const id = sessionsStore.activeId
  if (!id) return
  await sessionsStore.setInputs(id, { controlNet: draft })
  controlNetOpen.value = false
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
  status: 'running' | 'done' | 'stopped' | 'error' | 'converting'
  step?: number
  totalSteps?: number
  image?: { path: string; name: string; durationMs?: number }
  error?: string
}): void {
  // Every generation failure toasts — even when it belongs to a background
  // session — because the chat bubble shows only a generic failure line; the
  // detail lives in this toast and in data/logs/latest.log.
  if (p.status === 'error') {
    toast(p.error?.trim() || 'Generation failed', 'error', 8000)
  }
  // Per-session state first — recorded for EVERY session (background ones
  // included) so switching away and back keeps the busy indicator consistent
  // (plans/session-switch-busy-state.md).
  if (p.status === 'running') {
    genStore.markRunning(p.sessionId, p.step, p.totalSteps)
  } else if (p.status === 'converting') {
    genStore.markConverting(p.sessionId)
  } else {
    // done / stopped / error — terminal for that session.
    genStore.clear(p.sessionId)
  }
  if (p.sessionId !== sessionsStore.activeId) return
  // Real messages are now flowing from main — drop the optimistic placeholders.
  pendingPrompt.value = null
  pendingRefs.value = []
  if (p.status === 'running') {
    busy.value = true // self-heal: the store entry above is the truth
    if (p.step !== undefined) progress.value = { step: p.step, total: p.totalSteps ?? 0 }
  }
  // 'converting' — the .avi → .mp4 post-processing is running: keep busy +
  // show the indicator, no step update, no busy reset.
  if (p.status === 'converting') {
    converting.value = true
  }
  if (p.status === 'done') {
    busy.value = false
    progress.value = null
    converting.value = false
    toast('Image generated', 'ok')
  }
  if (p.status === 'stopped') {
    busy.value = false
    progress.value = null
    converting.value = false
    toast('Generation stopped', 'info')
  }
  if (p.status === 'error') {
    busy.value = false
    progress.value = null
    converting.value = false
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

// Programmatic prompt changes (e.g. the LLM enhancer replacing the text)
// don't fire `@input`, so re-grow the textarea whenever the value changes.
// `flush: 'post'` is required: the default `pre` flush would run before the
// DOM re-renders, so `scrollHeight` would still reflect the OLD text and the
// box would be sized too small (clipping the enhanced prompt).
watch(prompt, autoGrow, { flush: 'post' })

onMounted(async () => {
  window.api.onGenProgress(onGenProgress)
  // Main purged a stale mask reference during gen:start (the mask/background
  // file no longer exists — e.g. the launch wipe ate data/tmp/masks). Drop the
  // sticky state; main already deleted the files and showed the dialog.
  window.api.onMasksInvalidated(() => {
    maskState.value = null
    paintState.value = null
  })
  await refreshInstalled()
  // Rehydrate the busy state for the initially-selected session (covers a
  // dev reload mid-generation, where the generation store starts empty).
  await rehydrateGenerationState(sessionsStore.activeId)
  scrollToBottom()
})
onBeforeUnmount(() => {
  // listeners are process-lifetime in this app; nothing to clean up
})

watch(() => sessionsStore.active?.messages.length, scrollToBottom)
/**
 * Sync the local busy/progress/converting refs with the session's generation
 * state: mirror the generation-store entry when present, else ask main
 * (gen:state — the source of truth) and seed the store. Called on mount and
 * on every session switch; never clears a busy state the store still holds.
 * See plans/session-switch-busy-state.md.
 */
async function rehydrateGenerationState(id: string | null): Promise<void> {
  const e = id ? genStore.of(id) : undefined
  busy.value = !!e
  converting.value = e?.status === 'converting'
  progress.value = e?.step != null ? { step: e.step, total: e.totalSteps ?? 0 } : null
  if (!id || e) return
  try {
    const st = await window.api.genState(id)
    // The user may have switched again while the IPC was in flight.
    if (!st.running || sessionsStore.activeId !== id) return
    if (st.converting) genStore.markConverting(id)
    else genStore.markRunning(id)
    busy.value = true
    converting.value = st.converting
  } catch {
    // Main unreachable (teardown) — the mirrored store state stands.
  }
}

watch(() => sessionsStore.activeId, (id) => {
  void rehydrateGenerationState(id)
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
      <div v-if="!sessionsStore.active" class="empty-state">
        <div class="empty-avatar">◈</div>
        <h3>Welcome to Myriad Frame</h3>
        <p>Create or select a session on the left to start generating images.</p>
      </div>
      <template v-else>
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
              <template v-if="converting">Converting…</template>
              <template v-else>Generating</template>
              <template v-if="!converting && progress && progress.total"> · step {{ progress.step }}/{{ progress.total }}</template>
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
            <div v-if="m.refs && m.refs.length" class="refs">
              <ImageFromPath v-for="(r, i) in m.refs" :key="i" :path="r" :alt="'reference ' + (i + 1)" :max="120" />
            </div>
            <!-- Video-era channel chips (display-only, like refs). -->
            <div v-if="m.audioPath || m.controlVideoPath || m.endImagePath || m.audioReferencePaths?.length || m.videoReferencePaths?.length" class="refs">
              <span v-if="m.audioPath" class="chip-label mono" :title="m.audioPath">♪ {{ mediaBaseName(m.audioPath) }}</span>
              <span v-if="m.controlVideoPath" class="chip-label mono" :title="m.controlVideoPath">▣ {{ mediaBaseName(m.controlVideoPath) }}</span>
              <span v-if="m.endImagePath" class="chip-label mono" :title="m.endImagePath">⇥ {{ mediaBaseName(m.endImagePath) }}</span>
              <span v-for="p in m.audioReferencePaths ?? []" :key="'ar' + p" class="chip-label mono" :title="p">♪ {{ mediaBaseName(p) }}</span>
              <span v-for="p in m.videoReferencePaths ?? []" :key="'vr' + p" class="chip-label mono" :title="p">▣ {{ mediaBaseName(p) }}</span>
            </div>
            <div
              v-if="m.role === 'assistant' && busy && !m.image && m.status !== 'error' && m.status !== 'stopped'"
              class="gen-indicator"
            >
              <span class="spinner"></span>
              <span class="muted">
                <template v-if="converting">Converting…</template>
                <template v-else>Generating</template>
                <template v-if="!converting && progress && progress.total">
                  · step {{ progress.step }}/{{ progress.total }}
                </template>
              </span>
              <span class="dots"><span></span><span></span><span></span></span>
            </div>
            <div v-else-if="m.image" class="image-wrap">
              <ImageFromPath :path="m.image.path" alt="generated image" :max="480" clickable :duration-ms="m.image.durationMs" />
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
              <button
                class="icon upscale-image"
                title="Upscale image…"
                @click="upscalerStore.openDialog(m.image.path)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
              </button>
            </div>
            <div v-if="m.status === 'stopped'" class="status muted">Generation stopped</div>
            <div v-if="m.status === 'error'" class="status error">Generation failed — details in Settings → Logs</div>
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
    <footer class="composer-wrap">
      <div class="composer">
        <div v-if="refImages.length || inputImages.length || audioPath || controlVideoPath || endImagePath || audioRefPaths.length || videoRefPaths.length" class="refs">
          <div v-for="p in refImages" :key="'r' + p" class="ref-thumb">
            <ImageFromPath :path="p" :max="72" />
            <button class="icon remove" title="Remove" @click="removeRef(p)">×</button>
          </div>
          <div v-for="p in inputImages" :key="'i' + p" class="ref-thumb">
            <ImageFromPath :path="p" :max="72" />
            <span class="input-badge">input</span>
            <button class="icon remove" title="Remove" @click="removeInput(p)">×</button>
          </div>
          <!-- Video-era channel chips: sticky like the mask state — they ride
               every Send until cleared. -->
          <div v-if="audioPath" class="ref-thumb chip" :title="audioPath">
            <span class="chip-label mono">♪ {{ mediaBaseName(audioPath) }}</span>
            <button class="icon remove" title="Remove" @click="clearAudio()">×</button>
          </div>
          <div v-if="controlVideoPath" class="ref-thumb chip" :title="controlVideoPath">
            <span class="chip-label mono">▣ {{ mediaBaseName(controlVideoPath) }}</span>
            <button class="icon remove" title="Remove" @click="clearControlVideo()">×</button>
          </div>
          <div v-if="endImagePath" class="ref-thumb chip" :title="endImagePath">
            <span class="chip-label mono">⇥ {{ mediaBaseName(endImagePath) }}</span>
            <button class="icon remove" title="Remove" @click="clearEndImage()">×</button>
          </div>
          <!-- Repeatable reference-channel chips: one per path, sticky like
               the video-era chips — they ride every Send until removed. -->
          <div v-for="p in audioRefPaths" :key="'ar' + p" class="ref-thumb chip" :title="p">
            <span class="chip-label mono">♪ {{ mediaBaseName(p) }}</span>
            <button class="icon remove" title="Remove" @click="removeAudioRef(p)">×</button>
          </div>
          <div v-for="p in videoRefPaths" :key="'vr' + p" class="ref-thumb chip" :title="p">
            <span class="chip-label mono">▣ {{ mediaBaseName(p) }}</span>
            <button class="icon remove" title="Remove" @click="removeVideoRef(p)">×</button>
          </div>
        </div>
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
            :disabled="busy || enhancing"
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
            {{ busy ? 'Stop' : 'Generate' }}
          </button>
          <button v-if="appStore.configs?.application.debug?.preview" class="gen-btn preview-btn" :disabled="!prompt.trim() || busy" @click="preview()" title="Show full sd-cli command line without running">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Preview
          </button>
        </div>

        <div class="composer-tools">
          <button
            v-if="allowInput"
            class="icon"
            title="Add input images"
            :disabled="busy || !inputsEnabled || inputImages.length >= maxInput"
            @click="addInputs()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M12 8v8" />
              <path d="M8 12h8" />
            </svg>
          </button>
          <button
            v-if="allowRef"
            class="icon"
            title="Add reference images"
            :disabled="busy || !refsEnabled || refImages.length >= maxRef"
            @click="addRefs()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </button>
          <!-- Video-era channels (WAN): driving audio (S2V), control-frames
               directory (VACE) and end image (FLF2V). Gated by the sampling
               descriptor's channel `show` flags. -->
          <button
            v-if="allowAudio"
            class="icon"
            :class="{ active: !!audioPath }"
            title="Driving audio (Wan S2V)"
            aria-label="Driving audio"
            :disabled="busy"
            @click="addAudio()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </button>
          <button
            v-if="allowControlVideo"
            class="icon"
            :class="{ active: !!controlVideoPath }"
            title="Control video frames directory (VACE)"
            aria-label="Control video frames"
            :disabled="busy"
            @click="addControlVideo()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M2 9h20" />
              <path d="M7 4v5M12 4v5M17 4v5" />
            </svg>
          </button>
          <button
            v-if="allowEndImage"
            class="icon"
            :class="{ active: !!endImagePath }"
            title="End image (FLF2V)"
            aria-label="End image"
            :disabled="busy"
            @click="addEndImage()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="m9 9 6 6" />
              <path d="M15 9v6H9" />
            </svg>
          </button>
          <!-- Repeatable reference channels (MiniMax-H3 Ref2VA): reference
               audio (WAV file picker) and reference video (frames DIRECTORY
               picker — man.txt:278, not a media file). -->
          <button
            v-if="allowAudioRef"
            class="icon"
            :class="{ active: audioRefPaths.length > 0 }"
            title="Add reference audio"
            aria-label="Add reference audio"
            :disabled="busy || audioRefPaths.length >= maxAudioRef"
            @click="addAudioRef()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
              <path d="M2 2l20 20" />
            </svg>
          </button>
          <button
            v-if="allowVideoRef"
            class="icon"
            :class="{ active: videoRefPaths.length > 0 }"
            title="Add reference video frames directory"
            aria-label="Add reference video frames"
            :disabled="busy || videoRefPaths.length >= maxVideoRef"
            @click="addVideoRef()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M2 9h20" />
              <path d="M7 4v5M12 4v5M17 4v5" />
              <path d="M2 2l20 20" />
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
          <button
            class="icon"
            :class="{ active: (sessionsStore.active?.inputs?.lora?.mode ?? 'off') !== 'off' }"
            title="LoRA"
            aria-label="LoRA settings"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="loraOpen = true"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="8" y="3" width="13" height="13" rx="2" />
              <path d="M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h3" />
            </svg>
          </button>
          <button
            v-if="allowAdetailer"
            class="icon"
            :class="{ active: (sessionsStore.active?.inputs?.adetailer?.enabled ?? false) }"
            title="ADetailer"
            aria-label="ADetailer settings"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="adetailerOpen = true"
          >
            <svg xmlns="http://w3.org" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <!-- Main Face Circle (broken at top right for sparkle) -->
              <path d="M20.9 13.3A9 9 0 1 1 10.7 3.1" />
              <!-- Eyes & Smile -->
              <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
              <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
              <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
              <!-- AI Sparkle -->
              <path d="M19 2v6M16 5h6" />
            </svg>
          </button>
          <button
            v-if="allowIpAdapter"
            class="icon"
            :class="{ active: sessionsStore.active?.inputs?.ipAdapter?.apply === true }"
            title="IP Adapter"
            aria-label="IP Adapter settings"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="ipAdapterOpen = true"
          >
            <svg xmlns="http://w3.org" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <!-- Reference Image Frame (Top-Left) -->
              <rect x="3" y="3" width="11" height="11" rx="2" />
              <circle cx="6.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              <path d="M3.5 12l2.5-2.5 2 2 2.5-2.5 3 3" />
              <!-- Output / Target Frame (Bottom-Right) -->
              <path d="M14 10h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-5" />
              <!-- Transfer Arrow -->
              <path d="M14 14l4 4" />
              <path d="M15 18h3v-3" />
            </svg>

          </button>
          <button
            v-if="allowControlNet"
            class="icon"
            :class="{ active: sessionsStore.active?.inputs?.controlNet?.apply === true }"
            title="Control Net"
            aria-label="Control Net settings"
            aria-haspopup="dialog"
            :disabled="busy || !sessionsStore.activeId"
            @click="controlNetOpen = true"
          >

          <svg xmlns="http://w3.org" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/>
            <circle cx="12" cy="8" r="2"/>
            <path d="M8 14h8"/>
            <path d="M12 10v6"/>
            <path d="M9 20l3-4 3 4"/>
          </svg>

          </button>
          <button
            class="icon"
            :class="{ active: enhancing }"
            title="Enhance prompt"
            aria-label="Enhance prompt"
            :disabled="busy || (!prompt.trim() && !enhancing)"
            @click="enhance()"
          >
            <!-- sparkles / wand — while enhancing the icon pulses and a second
                 click cancels the in-flight enhancement -->
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linejoin="round"
              :class="{ 'enhance-busy': enhancing }"
            >
              <path d="M12 4l1.8 4.2L18 10l-4.2 1.8L12 16l-1.8-4.2L6 10l4.2-1.8z" />
              <path d="M19 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" />
              <path d="M13.5 8.5 21 1" />
            </svg>
          </button>
          <button
            v-if="allowPainting"
            class="icon"
            :class="{ active: paintState }"
            :title="paintTitle"
            aria-label="Paint"
            aria-haspopup="dialog"
            :disabled="paintDisabled"
            @click="openPaint()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
              <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
              <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
              <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.675-1.688 1.64 1.64 0 0 1 1.674 1.688c0 1.125-.437 2.164-1.152 2.936A9.996 9.996 0 0 0 22 12C22 6.5 17.5 2 12 2z" />
            </svg>
          </button>
          <button
            v-if="allowInpainting"
            class="icon"
            :class="{ active: maskState?.kind === 'inpaint' }"
            :title="inpaintTitle"
            aria-label="Inpaint"
            aria-haspopup="dialog"
            :disabled="inpaintDisabled"
            @click="openInpaint()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
              <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
            </svg>
          </button>
          <button
            v-if="allowInpainting"
            class="icon"
            :class="{ active: maskState?.kind === 'outpaint' }"
            :title="outpaintTitle"
            aria-label="Outpaint"
            aria-haspopup="dialog"
            :disabled="outpaintDisabled"
            @click="openOutpaint()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="8" y="8" width="8" height="8" />
              <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
            </svg>
          </button>
          <span v-if="maskState" class="muted faint">
            {{ maskState.kind === 'inpaint' ? 'Inpaint' : 'Outpaint' }} mask ·
            {{ maskState.width }}×{{ maskState.height }}<template v-if="maskState.overrideResolution"> · session resolution</template>
          </span>
          <span v-if="paintState" class="muted faint">
            Painted image · {{ paintState.width }}×{{ paintState.height }} ·
            {{ paintState.target === 'init' ? 'as input' : 'as first reference' }}
          </span>
          <span v-if="refImages.length" class="muted faint">
            {{ refImages.length }}/{{ maxRef }} reference{{ refImages.length === 1 ? '' : 's' }}
          </span>
          <span v-if="inputImages.length" class="muted faint">
            {{ inputImages.length }}/{{ maxInput }} input{{ inputImages.length === 1 ? '' : 's' }}
          </span>
          <label v-if="allowPreviousImage && (allowRef || allowInput)" class="chk">
            <input v-model="usePrevious" type="checkbox" :disabled="busy" />
            Use previous image
          </label>
          <select
            v-if="allowPreviousImage && usePrevious && (allowRef || allowInput)"
            v-model="previousMode"
            title="How the previous image is used"
            :disabled="busy"
            class="prev-mode"
          >
            <option value="input">As input</option>
            <option value="reference">As Reference</option>
          </select>
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
          <button
            class="model-chip"
            title="Resolution"
            aria-haspopup="dialog"
            aria-label="Select resolution"
            :disabled="busy || !resolutions.length"
            @click="resOpen = true"
          >
            <span class="model-chip-label">{{ resolutionLabel }}</span>
            <svg class="model-chip-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div v-if="sessionSampling" class="sampling-info ml-auto">
            <button class="icon sampling-info-btn" title="Sampling settings" aria-label="Sampling settings">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </button>
            <!-- Floating hover window: the configured sampling for the current
                 session (descriptor defaults ← settings overrides ← session
                 override). Pure-CSS hover — no click, no component state. -->
            <div class="sampling-popover" role="tooltip">
              <div class="sampling-popover-title">Sampling · {{ diffusionType }}</div>
              <table>
                <tbody>
                  <tr v-for="row in samplingRows" :key="row.label">
                    <th>{{ row.label }}</th>
                    <td :title="row.title">{{ row.value }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </footer>
    <div v-if="dropAsk" class="modal-backdrop" @click.self="dropAsk = null">
      <div class="modal-card">
        <h3>Add dropped images</h3>
        <p class="muted">
          Add {{ dropAsk.files.length }} dropped image{{ dropAsk.files.length === 1 ? '' : 's' }} as
          input (--init-img) or as reference (--ref-image)?
        </p>
        <div class="modal-actions">
          <button @click="settleDrop('input')">As input</button>
          <button @click="settleDrop('reference')">As Reference</button>
          <button class="ghost" @click="dropAsk = null">Cancel</button>
        </div>
      </div>
    </div>

    <ModelPickerDialog
      v-if="pickerOpen"
      :selected="modelEntry"
      @select="onPick"
      @close="pickerOpen = false"
    />
    <ResolutionSelectorDialog
      v-if="resOpen"
      :diffusion-type="diffusionType"
      :current="resolution"
      @select="onResolutionSelect"
      @close="resOpen = false"
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
    <LoraDialog
      v-if="loraOpen"
      :session-name="sessionsStore.active?.name ?? ''"
      @save="onSaveLora"
      @close="loraOpen = false"
    />
    <AdetailerDialog
      v-if="adetailerOpen"
      :session-id="sessionsStore.activeId!"
      @save="onSaveAdetailer"
      @close="adetailerOpen = false"
    />
    <IpAdapterDialog
      v-if="ipAdapterOpen"
      :session-id="sessionsStore.activeId!"
      @save="onSaveIpAdapter"
      @close="ipAdapterOpen = false"
    />
    <ControlNetDialog
      v-if="controlNetOpen"
      :session-id="sessionsStore.activeId!"
      @save="onSaveControlNet"
      @close="controlNetOpen = false"
    />
    <!-- Preview dialog: shows the full sd-cli command line without running -->
    <div v-if="previewOpen" class="preview-overlay" @click.self="previewOpen = false">
      <div class="preview-dialog">
        <div class="preview-header">
          <h3>sd-cli Command Preview</h3>
          <button class="preview-close" @click="previewOpen = false" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="preview-body">
          <div v-if="previewError" class="preview-error">{{ previewError }}</div>
          <pre v-else-if="previewCommand" class="preview-command">{{ previewCommand }}</pre>
          <div v-else class="muted">Generating preview...</div>
        </div>
        <div v-if="previewCommand" class="preview-actions">
          <button class="preview-copy-btn" @click="copyPreview">Copy to clipboard</button>
        </div>
      </div>
    </div>
    <InpaintDialog
      v-if="inpaintOpen"
      :background="inpaintBg"
      :restored-mask="inpaintRestoredMask"
      :override-resolution="inpaintOverride"
      @save="onInpaintSave"
      @clear="onMaskClear"
      @close="inpaintOpen = false"
    />
    <OutpaintDialog
      v-if="outpaintOpen"
      :background="outpaintBg"
      :restored-margins="outpaintRestoredMargins"
      :override-resolution="outpaintOverride"
      @save="onOutpaintSave"
      @clear="onMaskClear"
      @close="outpaintOpen = false"
    />
    <PaintDialog
      v-if="paintOpen"
      :background="paintBg"
      @save="onPaintSave"
      @clear="onPaintClear"
      @close="paintOpen = false"
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
.save-image,
.upscale-image {
  position: absolute;
  top: 8px;
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
.save-image {
  right: 8px;
}
.upscale-image {
  right: 44px;
}
.image-wrap:hover .save-image,
.image-wrap:hover .upscale-image {
  opacity: 1;
}
.save-image:hover,
.upscale-image:hover {
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
/* Enhance busy indicator: the sparkles icon pulses (scale + opacity) while
   the LLM runs; a second click on the button cancels the enhancement
   (llm:stop). */
@keyframes enhance-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.18);
    opacity: 0.55;
  }
}
.enhance-busy {
  animation: enhance-pulse 1.1s ease-in-out infinite;
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
/* sampling-info — the composer's ⓘ icon; hovering it floats a window with
   the configured sampling for the current session (replaces the old inline
   one-line summary, which could not carry the full descriptor). Shown on
   :hover and :focus-within (keyboard); the ::after bridge spans the gap
   between icon and window so the pointer never leaves the hover chain. */
.sampling-info {
  position: relative;
  display: inline-flex;
}
.sampling-info-btn {
  color: var(--text-faint);
}
.sampling-info-btn:hover:not(:disabled) {
  color: var(--text);
}
.sampling-popover {
  display: none;
  position: absolute;
  bottom: calc(100% + 8px);
  right: -6px;
  z-index: 80;
  min-width: 230px;
  max-width: 320px;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  font-size: 12px;
}
.sampling-popover::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 8px;
}
.sampling-info:hover .sampling-popover,
.sampling-info:focus-within .sampling-popover {
  display: block;
}
.sampling-popover-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.sampling-popover table {
  border-collapse: collapse;
  width: 100%;
}
.sampling-popover th {
  text-align: left;
  font-weight: normal;
  color: var(--text-dim);
  padding: 2px 12px 2px 0;
  white-space: nowrap;
  vertical-align: top;
}
.sampling-popover td {
  padding: 2px 0;
  word-break: break-word;
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
.input-badge {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 1px 5px;
  font-size: 9px;
  line-height: 1.4;
  border-radius: 4px 0 0 0;
  background: var(--accent);
  color: #fff;
  pointer-events: none;
}
/* Non-image channel chips (audio / control-frames dir / end image): a text
   tile in the refs strip, and a plain inline chip on persisted messages. */
.ref-thumb.chip {
  display: inline-flex;
  align-items: center;
  height: 72px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  max-width: 180px;
}
.chip-label {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prev-mode {
  font-size: 12px;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  width: 380px;
  max-width: calc(100vw - 48px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
.modal-card h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.modal-card p {
  margin: 0 0 14px;
  font-size: 13px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.modal-actions button {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  background: var(--bg-elevated);
  color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer;
}
.modal-actions button:hover {
  border-color: var(--accent);
}
.modal-actions button.ghost {
  background: transparent;
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

/* Preview dialog */
.preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-dialog {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 900px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.preview-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.preview-close {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-faint);
  padding: 4px;
  border-radius: 4px;
}
.preview-close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.preview-body {
  overflow: auto;
  flex: 1;
}
.preview-command {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
  max-height: 400px;
  overflow: auto;
}
.preview-error {
  color: var(--danger);
  font-size: 13px;
  background: rgba(220, 80, 80, 0.1);
  border: 1px solid rgba(220, 80, 80, 0.3);
  border-radius: 8px;
  padding: 12px;
}
.preview-copy-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}
.preview-copy-btn:hover {
  background: var(--bg-active);
}
.preview-btn {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--text-secondary);
}
.preview-btn:hover:not(:disabled) {
  background: var(--bg-active);
  color: var(--text);
}
</style>

