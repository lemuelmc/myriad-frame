<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CatalogEntry, GenerationRequest, ModelType, ResolutionEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore, type ModelDownloadState } from '../stores/settings'
import { toast } from '../toast'
import ImageFromPath from './ImageFromPath.vue'
import DownloadProgress from './DownloadProgress.vue'
import logoTiny from '../../../assets/logo-square-tiny.png'

const appStore = useAppStore()
const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()

// ---------- composer state ----------
const prompt = ref('')
const modelEntry = ref<CatalogEntry | null>(null)
const vaeEntry = ref<CatalogEntry | null>(null)
const encoderEntry = ref<CatalogEntry | null>(null)
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

const diffusionEntries = computed(() =>
  (appStore.catalog?.entries ?? []).filter(
    (e) => e.type === 'diffusion' && !e.name.startsWith('text_encoders/') && !e.name.startsWith('vae/')
  )
)
const diffusionType = computed(() => modelEntry.value?.diffusionType ?? '')
const resolutions = computed<ResolutionEntry[]>(() =>
  appStore.resolutionsFor(diffusionType.value)
)
const sampling = computed(() => {
  const base = appStore.configs?.sampling[diffusionType.value]
  if (!base) return null
  return settingsStore.samplingFor(diffusionType.value, base)
})
const maxRef = computed(() => sampling.value?.max_reference ?? 0)
const refsEnabled = computed(() => maxRef.value > 0)

// selected model label shown in the model chip
const modelLabel = computed(() => {
  const e = modelEntry.value
  if (!e) return 'Select model'
  const parts = [e.label || e.name]
  if (e.quant) parts.push(e.quant)
  return parts.join(' · ')
})

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
        toast(`Download failed: ${(err as Error).message}`, 'error')
        throw err
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
  }
  await p
}

// The selected diffusion model and its VAE / text encoder dependencies
// currently downloading (for the indicator).
const depDownloads = computed<{ key: string; label: string; state: ModelDownloadState }[]>(() => {
  const out: { key: string; label: string; state: ModelDownloadState }[] = []
  const model = modelEntry.value
  if (model) {
    const s = settingsStore.modelDownloads[`diffusion:${model.url}`]
    if (s) out.push({ key: `diffusion:${model.url}`, label: `Downloading model · ${model.name}`, state: s })
  }
  const vae = vaeEntry.value
  if (vae) {
    const s = settingsStore.modelDownloads[`vae:${vae.url}`]
    if (s) out.push({ key: `vae:${vae.url}`, label: `Downloading VAE · ${vae.name}`, state: s })
  }
  const enc = encoderEntry.value
  if (enc) {
    const s = settingsStore.modelDownloads[`encoder:${enc.url}`]
    if (s) out.push({ key: `encoder:${enc.url}`, label: `Downloading text encoder · ${enc.name}`, state: s })
  }
  const vision = visionEntry.value
  if (vision) {
    const s = settingsStore.modelDownloads[`vision:${vision.url}`]
    if (s) out.push({ key: `vision:${vision.url}`, label: `Downloading vision model · ${vision.name}`, state: s })
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
      visionEntry.value = null
      resolution.value = null
      return
    }
    const st = await window.api.settingsGet()
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
    // Resolution order: user-configured default (settings) > hub.json `default`
    // (a repo-relative path — match catalog entries by file name so a stale
    // cached catalog without isDefault flags still resolves correctly).
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
    // Vision (mmproj) model — only present for diffusion_types that declare a
    // `vision` dependency in hub.json (e.g. qwen_image_2.1).
    const userVisionName = st.defaultVision?.[dt]
    const defaultVision = appStore.configs?.hub.repo.vision[dt]?.default ?? ''
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
    resolution.value = resolutions.value[0] ?? null
    // Auto-download the selected diffusion model and its VAE / text encoder /
    // vision dependencies in the background.
    if (modelEntry.value) void ensureDownloaded(modelEntry.value)
    if (vaeEntry.value) void ensureDownloaded(vaeEntry.value)
    if (encoderEntry.value) void ensureDownloaded(encoderEntry.value)
    if (visionEntry.value) void ensureDownloaded(visionEntry.value)
  },
  { immediate: true }
)

watch(resolutions, (r) => {
  if (r.length && (!resolution.value || !r.some((x) => x.width === resolution.value!.width && x.height === resolution.value!.height))) {
    resolution.value = r[0]
  }
})

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
    // starts one if none is running.
    for (const e of [modelEntry.value, vaeEntry.value, encoderEntry.value, visionEntry.value]) {
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

    const s = sampling.value
    const req: GenerationRequest = {
      sessionId: sessionsStore.activeId,
      prompt: text,
      model: modelEntry.value.name,
      diffusionType: modelEntry.value.diffusionType,
      vae: vaeEntry.value?.name,
      encoder: encoderEntry.value?.name,
      vision: visionEntry.value?.name,
      resolution: resolution.value
        ? { width: resolution.value.width, height: resolution.value.height }
        : { width: s?.width ?? 1024, height: s?.height ?? 1024 },
      referencePaths: [...refs],
      usePrevious: usePrevious.value,
      previousImagePath: sessionsStore.lastGeneratedImage,
      steps: s?.steps ?? 25,
      cfg: s?.cfg ?? 1.0,
      sampler: s?.sampler ?? 'euler'
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

async function saveImage(image: { path: string; name: string }): Promise<void> {
  try {
    const saved = await window.api.saveImage(image.path)
    if (saved) toast('Image saved', 'ok')
  } catch (err) {
    toast((err as Error).message, 'error', 6000)
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
        <span class="chat-avatar">◈</span>
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
          <div class="avatar user">🙂</div>
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
            <span v-else>🙂</span>
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
              <ImageFromPath :path="m.image.path" alt="generated image" :max="480" />
              <button
                class="icon save-image"
                title="Save image as…"
                @click="saveImage(m.image)"
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
          <span v-if="refImages.length" class="muted faint">
            {{ refImages.length }}/{{ maxRef }} reference{{ refImages.length === 1 ? '' : 's' }}
          </span>
          <label v-if="refsEnabled" class="chk">
            <input v-model="usePrevious" type="checkbox" :disabled="busy || !refsEnabled" />
            Use previous image
          </label>
          <select v-model="modelEntry" class="model-select" title="Model" :disabled="busy">
            <option :value="null" disabled>{{ diffusionEntries.length ? 'Select model…' : 'No models in catalog' }}</option>
            <option v-for="e in diffusionEntries" :key="e.id" :value="e">
              {{ e.name }} {{ isInstalled(e) ? '✓' : '(not downloaded)' }}
            </option>
          </select>
          <select v-model="resolution" title="Resolution" :disabled="busy || !resolutions.length">
            <option v-for="r in resolutions" :key="r.name" :value="r">{{ r.name }} ({{ r.width }}×{{ r.height }})</option>
          </select>
          <span v-if="sampling" class="faint mono ml-auto">
            {{ sampling.steps }} steps · cfg {{ sampling.cfg }} · {{ sampling.sampler }}
          </span>
        </div>
      </div>
    </footer>
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
