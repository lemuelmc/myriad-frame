/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Shared types used by main, preload and renderer.

export type ModelType = 'diffusion' | 'encoder' | 'vae' | 'vision'

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

/** A model provider from hub.json. */
export interface HubProvider {
  [key: string]: { label: string }
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
}

/** Encoder entry from hub.json repo.encoder. */
export interface HubEncoderEntry {
  /** provider key (e.g. 'unsloth', 'abenzerps') — selects the download subdirectory */
  provider?: string
  /** human-readable label (e.g. 'Qwen3 VL 8B Instruct') */
  label: string
  url: string
  /** repo-relative file path (or full URL) of the default encoder */
  default: string
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
  /** config name (e.g. 'myriad_frame') */
  name: string
  /** human-readable label (e.g. 'Myriad Frame') */
  label: string
  /** config version (e.g. '1.0.0') */
  version: string
  /** top-level diffusion model definitions */
  diffusion_models: HubDiffusionModel[]
  /** available model providers */
  providers: HubProvider[]
  repo: {
    /** diffusionType -> VAE repo + default file; the legacy plain-URL form is still accepted at runtime */
    vae: Record<string, HubVaeEntry | string>
    /** diffusionType -> encoder repo + default file */
    encoder: Record<string, HubEncoderEntry>
    /** diffusionType -> vision (mmproj) repo + default file, when the diffusion_type needs a vision model */
    vision: Record<string, HubVisionEntry>
    /** list of downloadable diffusion model quantizations */
    diffusion: HubDiffusionEntry[]
  }
}

// ---------- configurations/sampling.json ----------
export interface SamplingDefaults {
  max_reference: number
  steps: number
  cfg: number
  sampler: string
  width: number
  height: number
}

export type SamplingConfig = Record<string, SamplingDefaults>

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

export interface AllConfigs {
  hub: HubConfig
  sampling: SamplingConfig
  resolution: ResolutionConfig
  runtime: RuntimeConfig
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

export interface Session {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
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
export interface GenerationRequest {
  sessionId: string
  prompt: string
  /** diffusion model file name (from catalog / models dir) */
  model: string
  /** diffusion_type of the selected model (from hub.json) */
  diffusionType: string
  /** vae file name (from models dir) */
  vae?: string
  /** encoder file name (from models dir) */
  encoder?: string
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
