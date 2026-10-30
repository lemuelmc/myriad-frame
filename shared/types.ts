/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Shared types used by main, preload and renderer.

export type ModelType = 'diffusion' | 'encoder' | 'vae' | 'vision'

/**
 * Renderer theme key. Kept open-ended (`string`) so new themes can be added in
 * `theme.ts` without touching every type site, but the known set is listed here
 * for documentation and autocomplete.
 */
export type ThemeKey =
  | 'default'
  | 'halloween'
  | 'christmas'
  /** Any future theme key added to the registry in `theme.ts`. */
  | (string & {})

// ---------- configurations/hub.json ----------

/** A diffusion model definition from hub.json (top-level diffusion_models array). */
export interface HubDiffusionModel {
  name: string
  label: string
  /** 'image' or other inference modalities */
  type: string
  /** 'image' or 'image_unified' — controls UI behavior */
  mode: string
}

/** A model provider from hub.json — a flat `{ name, label }` entry. */
export interface HubProvider {
  /** provider key (e.g. 'unsloth', 'black_forest_labs') */
  name: string
  /** human-readable label (e.g. 'Unsloth') */
  label: string
}

/** Entry in hub.json repo.diffusion — a quantized diffusion model from a HuggingFace repo. */
export interface HubDiffusionEntry {
  /** provider key (e.g. 'unsloth', 'abenzerps') */
  provider: string
  /** unique model name (e.g. 'unsloth_qwen_image_2.1') */
  name: string
  /** human-readable label (e.g. 'Unsloth/Qwen Image 2.1') */
  label: string
  /** inference type (e.g. 'image') */
  inference_type: string
  /** quantization type (e.g. 'gguf') */
  quant_type: string
  /** diffusion_type this model belongs to (e.g. 'qwen_image_2_1', 'z_image') */
  diffusion_type: string
  /** HuggingFace repo URL */
  url: string
  /** short description shown in the model picker (from hub.json) */
  description?: string
  /**
   * optional repo-relative folder of `url` to restrict the scan to
   * (e.g. '/TURBO' — that folder's direct files); '/' scans only the repo
   * root's direct files (no recursion)
   */
  path?: string
}

/** One file of an encoder bundle (sd3.5-style). */
export interface HubEncoderDefault {
  /** repo-relative file path (or full URL) of the encoder file */
  file: string
  /** flag name the file is passed as at spawn (e.g. 'clip_g', 't5xxl') */
  use_as: string
}

/** Encoder entry from hub.json repo.encoder. */
export interface HubEncoderEntry {
  /** provider key (e.g. 'unsloth', 'abenzerps') — selects the download subdirectory */
  provider?: string
  /** human-readable label (unused by the bundle path; bundle descriptors take their label from the file basename) */
  label?: string
  url: string
  /**
   * Single-file shape: repo-relative file path (or full URL) of the default encoder.
   * Bundle shape: an array of `{ file, use_as }` pairs (SD3.5-style multi-encoder).
   * Exactly one of `default` / `defaults` is expected per entry.
   */
  default?: string
  /** array of `{ file, use_as }` pairs — the multi-file encoder bundle */
  defaults?: HubEncoderDefault[]
}

/** VAE entry from hub.json repo.vae. */
export interface HubVaeEntry {
  /** provider key (e.g. 'unsloth', 'black_forest_labs') — selects the download subdirectory */
  provider?: string
  url: string
  /** repo-relative file path (or full URL) of the default VAE */
  default: string
}

/** Vision (mmproj) entry from hub.json repo.vision. */
export interface HubVisionEntry {
  /** provider key (e.g. 'qwen') — selects the download subdirectory */
  provider?: string
  label?: string
  url: string
  /** repo-relative file path (or full URL) of the default vision (mmproj) model */
  default: string
}

export interface HubConfig {
  /** "last updated" marker carried by the file (and the override) as-is */
  updatedOn: string
  /** top-level diffusion model definitions */
  diffusion_models: HubDiffusionModel[]
  /** available model providers */
  providers: HubProvider[]
  repo: {
    /** diffusionType -> VAE repo + default file; the legacy plain-URL form is still accepted at runtime */
    vae: Record<string, HubVaeEntry | string>
    /** diffusionType -> encoder repo + default file (single-file `default`) or encoder bundle (`defaults[]`) */
    encoder: Record<string, HubEncoderEntry>
    /** diffusionType -> vision (mmproj) repo + default file, when the diffusion_type needs a vision model; absent when none does */
    vision?: Record<string, HubVisionEntry>
    /** list of downloadable diffusion model quantizations */
    diffusion: HubDiffusionEntry[]
  }
}

// ---------- configurations/sampling.json ----------
export interface SamplingDefaults {
  /** how the model file is passed to sd-cli: 'standalone' (default) passes
   *  weights-only files via `--diffusion-model`, with conditioners/VAE as
   *  separate files; 'all_in_one' passes a full checkpoint (conditioners +
   *  VAE inside the file) via `--model` */
  diffusion_behavior: 'all_in_one' | 'standalone'
  /** whether this diffusion type accepts reference images at all;
   *  gates the 'Use previous image' checkbox and previous-image chaining */
  allow_reference: boolean
  max_reference: number
  /** img2img support: when true AND 'Use previous image' is checked, the
   *  referenced image is passed as the init image (--init-img) instead of
   *  a reference (--ref-image) */
  img2img: boolean
  /** denoise strength for img2img runs — emitted as `--strength` only
   *  alongside the init image (sd-cli default 0.75) */
  strength: number
  steps: number
  cfg: number
  sampler: string
  scheduler?: string | null
  negative?: string | null
  width: number
  height: number
}

export type SamplingConfig = Record<string, SamplingDefaults>

/** Canonical list of sd-cli sampling methods (from `--sampling-method` help). */
export const SAMPLER_METHODS = [
  'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2',
  'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s',
  'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde',
  'dpm++2m_sde_bt', 'lms'
] as const

/** Canonical list of sd-cli schedulers (from `--scheduler` help). */
export const SCHEDULERS = [
  'discrete', 'karras', 'exponential', 'ays', 'gits', 'sgm_uniform', 'simple',
  'smoothstep', 'kl_optimal', 'lcm', 'bong_tangent', 'ltx2', 'logit_normal',
  'flux2', 'flux', 'beta', 'llada_image'
] as const

/**
 * App-level default sampler — the app always emits `--sampling-method`, and
 * sd-cli's own default is model-family-dependent (euler for Flux/SD3/Wan,
 * euler_a otherwise). Used by the ChatPanel request fallback
 * (`sampler: s?.sampler ?? DEFAULT_SAMPLER`), replacing the hardcoded 'euler'
 * literal so the default lives in one place.
 */
export const DEFAULT_SAMPLER = 'euler'

/**
 * Sentinel for the Scheduler dropdown: emit no --scheduler flag (sd-cli
 * default). Also the value stored in a session override when the user picks
 * "model-specific" — session overrides never store null for the scheduler, so
 * downstream checks stay single-path.
 */
export const SCHEDULER_MODEL_DEFAULT = 'model-specific'

// ---------- configurations/resolution.json ----------
export interface ResolutionEntry {
  name: string
  width: number
  height: number
}

export type ResolutionConfig = Record<string, ResolutionEntry[]>

// ---------- configurations/runtime.json ----------
export type RuntimeKey =
  | 'windows_cuda'
  | 'windows_cuda12'
  | 'windows_cuda12_libraries'
  | 'windows_rocm'
  | 'windows_vulkan'
  | 'windows_cpu'
  | 'macos_silicon'
  | 'linux_amd'
  | 'linux_vulkan'
  | 'linux_cpu'

/** version (e.g. "987") -> runtime key -> download url */
export type RuntimeConfig = Record<string, Partial<Record<RuntimeKey, string>>>

/** Result of `runtime:checkUpdates` (Settings → Runtime → Check). */
export interface RuntimeCheckResult {
  /** true when the remote config differed from the active one and was written */
  updated: boolean
  /** versions present in the remote config but not in the previous one */
  newVersions: string[]
  /** versions present in the previous config but not in the remote one */
  removedVersions: string[]
}

// ---------- configurations/application.json ----------
/** App identity (name / label / version), shipped with the app. */
export interface ApplicationConfig {
  /** machine name (e.g. 'myriad_frame') */
  name: string
  /** human-readable label (e.g. 'Myriad Frame') */
  label: string
  /** app version (e.g. '0.1.1'); kept manually in sync with package.json */
  version: string
}

/** Result of `hub:checkUpdates` (Settings → Models → Check). */
export interface HubCheckResult {
  /** true when the remote config differed from the active one and was written */
  updated: boolean
  /** diffusion model names present in the remote config but not in the previous one */
  addedModels: string[]
  /** diffusion model names present in the previous config but not in the remote one */
  removedModels: string[]
}

export interface AllConfigs {
  hub: HubConfig
  sampling: SamplingConfig
  resolution: ResolutionConfig
  runtime: RuntimeConfig
  application: ApplicationConfig
}

// ---------- hub catalog (cached) ----------
export interface CatalogEntry {
  /** unique id: `${type}:${diffusionType}:${fileName}` */
  id: string
  type: ModelType
  diffusionType: string
  /** file name on disk, e.g. Qwen3-VL-8B-Instruct-Q4_K_S.gguf */
  name: string
  label: string
  url: string
  size?: number
  quant?: string
  isDefault?: boolean
  repo?: string
  provider?: string
  /** per-repo short description (from hub.json diffusion entries) */
  description?: string
  /** for an encoder bundle file, the CLI flag name it is passed as (e.g. 'clip_g', 't5xxl') */
  useAs?: string
}

export interface HubCatalog {
  scannedAt: number
  source: string
  entries: CatalogEntry[]
}

// ---------- sessions ----------
export interface ChatImage {
  /** absolute path on disk */
  path: string
  name: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** generated image (assistant) */
  image?: ChatImage
  /** reference image paths (user) */
  refs?: string[]
  status?: 'ok' | 'stopped' | 'error'
  error?: string
  createdAt: number
}

/** Composer inputs a session remembers. Optional — legacy session files lack it. */
/** The sampling rows a session may override (everything from the Sampling
 *  settings except the Negative textarea, which has its own field, and the
 *  width/height rows, which are no longer overridable per session — the
 *  resolution selected in the chat panel always wins). */
export type SessionSamplingOverride = Partial<
  Pick<SamplingDefaults, 'steps' | 'cfg' | 'strength' | 'sampler' | 'scheduler'>
>

export interface SessionInputs {
  /** diffusion model file name (CatalogEntry.name) */
  model?: string
  /** diffusion_type of the saved model — narrows catalog re-resolution */
  diffusionType?: string
  /** saved resolution entry */
  resolution?: ResolutionEntry
  /** per-session negative prompt; empty string clears */
  negativePrompt?: string
  /** per-session sampling override; null clears */
  sampling?: SessionSamplingOverride | null
}

export interface Session {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** remembered composer inputs (selected model + resolution) */
  inputs?: SessionInputs
}

// ---------- settings (data/settings.json) ----------
export interface Settings {
  /** selected runtime version, e.g. "987" */
  runtimeVersion?: string
  /** diffusionType -> vae file name (default VAE) */
  defaultVae?: Record<string, string>
  /** diffusionType -> encoder file name (default text encoder) */
  defaultEncoder?: Record<string, string>
  /** diffusionType -> vision (mmproj) file name (default vision model) */
  defaultVision?: Record<string, string>
  /** diffusionType -> sampling overrides */
  sampling?: Record<string, Partial<SamplingDefaults>>
  /** global performance / inference flags (applied to every generation) */
  performance?: PerformanceSettings
  /** renderer theme key (see ThemeKey); applied via documentElement data-theme */
  theme?: ThemeKey
}

export type FlashAttentionMode = 'on' | 'off' | 'auto'
export type ConvDirectMode = 'on' | 'off' | 'auto'
export type VaeTileSize = 'off' | '256x256' | '512x512'
export type OffloadMode = 'off' | 'on'
export type ParamBackendMode = 'off' | 'cpu' | 'gpu' | 'disk' | 'custom'

export interface PerformanceSettings {
  /**
   * Master switch. When false, no performance flags are applied to a
   * generation (the settings block is treated as inert). When true, the
   * individual flags below are honored.
   */
  enabled: boolean
  flashAttention: FlashAttentionMode
  convDirect: ConvDirectMode
  vaeTiling: {
    /** tile size; `off` disables VAE tiling entirely */
    tileSize: VaeTileSize
    /** overlap fraction between tiles */
    overlap: number
  }
  offloadToCpu: OffloadMode
  /** when 'custom', the raw backend string to pass to --params-backend */
  paramBackend: ParamBackendMode
  /** free-form value used when paramBackend === 'custom' */
  paramBackendCustom: string
}

// ---------- generation ----------
/** A resolved encoder file and the CLI flag name it is passed under at spawn. */
export interface EncoderRef {
  name: string
  useAs: string
  /** encoder provider key (hub.json) — disambiguates a basename collision
   *  across provider subdirectories */
  provider?: string
}

export interface GenerationRequest {
  sessionId: string
  prompt: string
  /** diffusion model file name (from catalog / models dir) */
  model: string
  /** diffusion_type of the selected model (from hub.json) */
  diffusionType: string
  /** vae file name (from models dir) */
  vae?: string
  /** vae provider key (hub.json) — disambiguates a basename collision across
   *  provider subdirectories (e.g. black_forest_labs vs huaweilin for sd3_5) */
  vaeProvider?: string
  /** encoder file name (from models dir) — single-file legacy path */
  encoder?: string
  /** encoder provider key (hub.json) — disambiguates a basename collision
   *  across provider subdirectories for the single-file (legacy) path */
  encoderProvider?: string
  /** encoder bundle (SD3.5-style multi-encoder): resolved files + their CLI flag names */
  encoders?: EncoderRef[]
  /** vision (mmproj) file name (from models dir) */
  vision?: string
  resolution: { width: number; height: number }
  /** absolute paths of user reference images */
  referencePaths: string[]
  usePrevious: boolean
  /** absolute path of the session's last generated image */
  previousImagePath?: string
  steps: number
  cfg: number
  sampler: string
  /** sigma scheduler; omitted or 'model-specific' ⇒ no --scheduler flag */
  scheduler?: string
  /** negative prompt for this generation; empty/omitted ⇒ no --negative-prompt flag */
  negativePrompt?: string
  /** denoise strength for img2img runs (sampling.json `strength`) */
  strength: number
  /** global performance flags applied to this generation */
  performance?: Partial<PerformanceSettings>
}

export interface GenProgress {
  sessionId: string
  messageId: string
  status: 'running' | 'done' | 'stopped' | 'error'
  step?: number
  totalSteps?: number
  image?: ChatImage
  error?: string
}

// ---------- platform ----------
export interface PlatformInfo {
  os: 'win32' | 'darwin' | 'linux'
  gpu: 'nvidia' | 'amd' | 'none' | 'unknown'
  gpuDetail?: string
  runtimeKey: RuntimeKey
}

// ---------- runtime ----------
export interface RuntimeVersionInfo {
  version: string
  /** true if extracted and sd-cli binary present */
  installed: boolean
  /** true if download is currently in progress */
  downloading: boolean
  /** bytes downloaded so far (while downloading) */
  downloadedBytes: number
  totalBytes: number
  /** absolute path to sd-cli binary when installed */
  binary?: string
}

export interface ModelFile {
  name: string
  size: number
  modifiedAt: number
}

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  /**
   * Current phase of the operation. `downloading` while fetching bytes;
   * `extracting` while unpacking a runtime archive (runtime downloads only).
   */
  phase?: 'downloading' | 'extracting'
}

// ---------- downloads registry ----------
/** Lifecycle status of a persisted model download entry. */
export type DownloadStatus = 'pending' | 'downloading' | 'failed'

/**
 * Message carried by the error that rejects a download promise when the user
 * cancels (or pauses) it. Main throws it (`DownloadAbortError`); the renderer
 * matches on the message — Electron IPC preserves `message` but not the error
 * class — to suppress misleading "download failed" toasts for a deliberate
 * cancel.
 */
export const DOWNLOAD_ABORTED_MESSAGE = 'Download aborted'

/**
 * A persisted model download record (data/downloads.json). Keyed by `url` in
 * the registry; carries no byte counts — live progress is tracked separately
 * via `models:progress` events.
 */
export interface DownloadEntry {
  type: ModelType
  url: string
  /** resolved provider key, stored as 'default' when the caller omitted it */
  provider: string
  /** file name (basename of the URL path) */
  name: string
  /** epoch ms when the entry was (re)queued; drives retry ordering */
  startedAt: number
  status: DownloadStatus
  /** true when the caller requested a force-redownload */
  force?: boolean
  /** error message, present while status === 'failed' */
  error?: string
}

/**
 * Shape returned by `downloads:list` and carried on the `downloads:changed`
 * push event.
 */
export interface DownloadsListResult {
  models: DownloadEntry[]
  /** runtime row for the selected runtime version */
  runtime: {
    version: string
    installed: boolean
    downloading: boolean
    phase?: 'downloading' | 'extracting'
  }
  paused: boolean
}

// ---------- init pipeline ----------
export type InitStage = 'platform' | 'runtime' | 'catalog' | 'done'

export interface InitStatus {
  stage: InitStage
  message: string
  platform?: PlatformInfo
  downloadedBytes?: number
  totalBytes?: number
  /** 'downloading' while fetching, 'extracting' while unpacking the runtime archive */
  phase?: 'downloading' | 'extracting'
}

/** Full init state, pulled by the renderer on mount to catch up on missed events. */
export interface InitState extends InitStatus {
  ready: boolean
}

// ---------- logging ----------
/** Renderer console levels forwarded over `logs:forward`. */
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

/** Shape returned by `logs:get` (Settings → Logs, read on demand). */
export interface LogsInfo {
  /** decoded tail of data/logs/latest.log (at most the last 1 MB) */
  content: string
  /** full file size in bytes (content may be a shorter tail) */
  size: number
}
