/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Shared types used by main, preload and renderer.

export type ModelType = 'diffusion' | 'encoder' | 'vae' | 'vision' | 'lora' | 'tokenizer'

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
  /**
   * Optional CivitAI version filter (CivitAI entries only): when present and
   * non-null, the hub scan lists ONLY the model versions whose ids appear
   * here — e.g. `[2948058]` pins the entry to that version's files (with
   * `path: '/'`, its primary file). Ignored by every other source.
   * Absent/null → every version is listed (subject to `path`).
   */
  model_version_ids?: number[]
  /**
   * Optional pagination cap (HuggingFace entries): the maximum number of
   * PAGES the HF tree scan fetches (100 files per page). Absent → 1 page.
   * Ignored by every other source.
   */
  max_page?: number
  /**
   * Optional model-source override: a source name (`huggingface`) or a domain
   * (`huggingface.co`) that forces source selection regardless of the URL
   * host. `source` wins over `domain` when both are present. Absent → the
   * source is derived from the URL's hostname.
   */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
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
  /**
   * Optional model-source override: a source name (`huggingface`) or a domain
   * (`huggingface.co`) that forces source selection regardless of the URL
   * host. `source` wins over `domain` when both are present. Absent → the
   * source is derived from the URL's hostname.
   */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** VAE entry from hub.json repo.vae. */
export interface HubVaeEntry {
  /** provider key (e.g. 'unsloth', 'black_forest_labs') — selects the download subdirectory */
  provider?: string
  url: string
  /** repo-relative file path (or full URL) of the default VAE */
  default: string
  /**
   * Optional model-source override: a source name (`huggingface`) or a domain
   * (`huggingface.co`) that forces source selection regardless of the URL
   * host. `source` wins over `domain` when both are present. Absent → the
   * source is derived from the URL's hostname. (The legacy plain-URL VAE
   * form — a bare URL string — cannot carry an override and relies on
   * URL-host matching only.)
   */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** Vision (mmproj) entry from hub.json repo.vision. */
export interface HubVisionEntry {
  /** provider key (e.g. 'qwen') — selects the download subdirectory */
  provider?: string
  label?: string
  url: string
  /** repo-relative file path (or full URL) of the default vision (mmproj) model */
  default: string
  /**
   * Optional model-source override: a source name (`huggingface`) or a domain
   * (`huggingface.co`) that forces source selection regardless of the URL
   * host. `source` wins over `domain` when both are present. Absent → the
   * source is derived from the URL's hostname.
   */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** Tokenizer entry from hub.json repo.tokenizer. */
export interface HubTokenizerEntry {
  /** provider key (e.g. 'open_moss_team') — selects the download subdirectory */
  provider?: string
  label?: string
  url: string
  /** repo-relative file path (or full URL) of the tokenizer file (e.g. 'tokenizer.json') */
  default: string
  /**
   * Optional model-source override: a source name (`huggingface`) or a domain
   * (`huggingface.co`) that forces source selection regardless of the URL
   * host. `source` wins over `domain` when both are present. Absent → the
   * source is derived from the URL's hostname.
   */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** LoRA entry from hub.json repo.lora — a downloadable LoRA adapter repo
 *  (CivitAI model page or HuggingFace repo). Unlike the other repo sections,
 *  a lora entry serves MULTIPLE diffusion types (`diffustion_types[]`) and has
 *  no `default` file — every scanned file is a catalog row. */
export interface HubLoraEntry {
  /** provider key (e.g. 'captain_daddy') — recorded on entries + the download registry */
  provider: string
  /** human-readable label (e.g. 'ENI Pattern') */
  label: string
  /** short description shown in the LoRA browser */
  description?: string
  /** diffusion types this LoRA is offered for (hub.json key kept as-is) */
  diffustion_types: string[]
  /** CivitAI model URL or HuggingFace repo URL */
  url: string
  /** optional scan restriction — same grammar as diffusion entries ('/' = repo-root direct children, absent = whole repo) */
  path?: string
  /** optional CivitAI version filter (same rule as diffusion entries) */
  model_version_ids?: number[]
  /** optional pagination cap (HuggingFace entries; same rule as diffusion entries) */
  max_page?: number
  /** optional model-source override (same semantics as diffusion entries) */
  source?: string
  /** optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
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
    /** diffusionType -> tokenizer repo + default file, when the diffusion_type needs a tokenizer; absent when none does */
    tokenizer?: Record<string, HubTokenizerEntry>
    /** list of downloadable diffusion model quantizations */
    diffusion: HubDiffusionEntry[]
    /** downloadable LoRA adapters; optional so older hub.json overrides without it stay valid */
    lora?: HubLoraEntry[]
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
   *  gates the 'Add reference images' button and --ref-image chaining */
  allow_reference: boolean
  max_reference: number
  /** whether this diffusion type accepts explicit input images at all
   *  (img2img-style); gates the 'Add input images' button */
  allow_image_input: boolean
  /** max number of input images (single --init-img path, so >1 is a
   *  picker-dialog cap only; sd-cli takes one init image) */
  max_image_input: number
  /** inpainting / outpainting support: when true the composer's Inpaint and
   *  Outpaint buttons are enabled and a saved mask is emitted as `--mask`
   *  alongside `--init-img` at spawn */
  allow_inpainting: boolean
  /** paint-tool support: when true the composer's Paint button is shown and a
   *  saved painted image is routed into --init-img or the first --ref-image
   *  at spawn; absent/false hides the button and main drops any paint fields
   *  (defense-in-depth). Optional — older sampling.json entries may omit it. */
  allow_painting?: boolean
  /** denoise strength for img2img runs — emitted as `--strength` only
   *  alongside the init image (sd-cli default 0.75) */
  strength: number
  steps: number
  cfg: number
  sampler: string
  scheduler?: string | null
  /**
   * Flow-model timestep shift (--flow-shift). `null` / `''` / absent means the
   * flag is NOT emitted (sd-cli default: auto); any finite number - including
   * 0 - is emitted as `--flow-shift <n>`.
   */
  flow_shift?: number | '' | null
  /**
   * Per-run RNG seed. A finite integer in [0, SEED_MAX] is emitted as a fixed
   * `--seed <n>` on every generation; null / absent (also the shipped
   * sampling.json shape — the field is never set there) means a fresh random
   * seed per run. `''` is a transient v-model artifact (dialog input), never
   * persisted.
   */
  seed?: number | '' | null
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

/** sd-cli's seed bounds: 32-bit unsigned (man.txt:257 — "-s, --seed  RNG seed
 *  (default: 42, use random seed for < 0)"). */
export const SEED_MAX = 4294967295

/** True for a storable fixed seed — a finite integer in [0, SEED_MAX]. Rejects
 *  '', null, undefined, negatives, and out-of-range values. Shared by the
 *  session-sampling dialog, the sessions whitelist, gen:start, and buildArgs. */
export function isValidSeed(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= SEED_MAX
}

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

/**
 * Which configs have unapplied remote changes, detected by the launch-time
 * update check (`checkForConfigUpdates`). Detect-only: applying is a manual
 * Settings → Models/Runtime → `Check` action. Delivered to the renderer via
 * the `updates:available` push and the `updates:get` pull (null until the
 * first launch check of the session completes).
 */
export interface ConfigUpdateStatus {
  /** the remote hub.json differs from the active one */
  hub: boolean
  /** the remote runtime.json differs from the active one */
  runtime: boolean
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
  /**
   * Model source provenance + download-time routing key (e.g. 'huggingface') —
   * the post-override resolved source NAME stamped by buildCatalog on every
   * source-dispatched entry. NOT the same as `HubCatalog.source` (the app
   * name from application.json). Entries that bypass a source (legacy
   * plain-URL VAE strings) carry no stamp and degrade to URL-host matching
   * at download time.
   */
  source?: string
}

export interface HubCatalog {
  scannedAt: number
  /** app identity from application.json — NOT the per-entry model-source routing key (CatalogEntry.source) */
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
  /** legacy only — raw error text is no longer persisted or rendered; errors live in the log + toasts */
  error?: string
  createdAt: number
}

/** Composer inputs a session remembers. Optional — legacy session files lack it. */
/** The sampling rows a session may override (everything from the Sampling
 *  settings except the Negative textarea, which has its own field, and the
 *  width/height rows, which are no longer overridable per session — the
 *  resolution selected in the chat panel always wins). */
export type SessionSamplingOverride = Partial<
  Pick<SamplingDefaults, 'steps' | 'cfg' | 'strength' | 'sampler' | 'scheduler' | 'flow_shift' | 'seed'>
>

/**
 * Per-session LoRA loading mode — the value passed to sd-cli's
 * `--lora-apply-mode`. `'off'` (the default for sessions without a saved
 * config) emits NEITHER `--lora-model-dir` NOR `--lora-apply-mode`.
 */
export type LoraApplyMode = 'off' | 'auto' | 'immediately' | 'at_runtime'

/** Per-session LoRA settings (session.inputs.lora). */
export interface SessionLora {
  mode: LoraApplyMode
  /** absolute custom directory for --lora-model-dir; absent → default data/models/lora */
  dir?: string
}

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
  /** per-session LoRA config; absent = off (no lora flags at spawn); null clears */
  lora?: SessionLora | null
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
  /** diffusionType -> tokenizer file name (default tokenizer) */
  defaultTokenizer?: Record<string, string>
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
  /** tokenizer file name (from models dir) */
  tokenizer?: string
  resolution: { width: number; height: number }
  /** absolute paths of user reference images (--ref-image channel) */
  referencePaths: string[]
  /** absolute paths of user input images (--init-img channel); distinct
   *  from referencePaths (--ref-image channel) */
  inputImagePaths: string[]
  usePrevious: boolean
  /** how the previous image is chained this request: 'input' or 'reference'.
   *  Chosen by the user in the composer dropdown; main re-validates. */
  previousImageMode?: 'input' | 'reference'
  /** absolute path of the session's last generated image */
  previousImagePath?: string
  /** absolute path of the saved mask PNG (data/tmp/masks); set only when
   *  the user saved a mask in the inpaint/outpaint dialog */
  maskPath?: string
  /** absolute path of the init image the mask was drawn on (inpaint:
   *  the background image; outpaint: the padded composition). Wins over
   *  the img2img previous-image reinterpretation. */
  initImagePath?: string
  /** absolute path of the merged paint image (data/tmp/masks); set only
   *  when the user saved a paint. Mutually exclusive with maskPath by
   *  construction — the composer's switch-guard keeps one tool state at a
   *  time, and main guards the combination anyway. */
  paintImagePath?: string
  /** how the paint image is routed: 'init' → the --init-img slot (wins over
   *  the previous-image chaining and user-picked inputs, same precedence
   *  slot as the mask background), 'reference' → the first --ref-image slot
   *  (the original first ref is replaced). Decided at paint-save time from
   *  the background's source; anything else is treated as absent by main. */
  paintTarget?: 'init' | 'reference'
  steps: number
  cfg: number
  sampler: string
  /** sigma scheduler; omitted or 'model-specific' ⇒ no --scheduler flag */
  scheduler?: string
  /** flow-model shift; RAW merged value (finite number incl 0, '', null, or
   *  undefined). Main resolves the global fallback + normalization: a finite
   *  number ⇒ --flow-shift; anything else ⇒ no flag. */
  flowShift?: number | '' | null
  /** RNG seed; RAW merged value (finite integer in [0, SEED_MAX], null, or
   *  undefined). Main resolves the session fallback + normalization: a valid
   *  integer ⇒ fixed --seed; anything else ⇒ buildArgs generates a fresh
   *  random seed per run. */
  seed?: number | '' | null
  /** negative prompt for this generation; empty/omitted ⇒ no --negative-prompt flag */
  negativePrompt?: string
  /** denoise strength for img2img runs (sampling.json `strength`) */
  strength: number
  /** global performance flags applied to this generation */
  performance?: Partial<PerformanceSettings>
}

/** Renderer → main payload for `masks:save` (inpaint / outpaint / paint dialog Save). */
export interface MaskSaveRequest {
  /** 'paint' carries the MERGED background+strokes image in `maskPng` (brush
   *  colors preserved, no initPng); saveMask writes it like any mask PNG. */
  kind: 'inpaint' | 'outpaint' | 'paint'
  /** PNG data URL — painted = opaque, unpainted = transparent alpha (paint:
   *  the merged image, opaque strokes over the background) */
  maskPng: string
  /** PNG data URL — outpaint only: the padded init image */
  initPng?: string
}

/** Result of `masks:save` — absolute paths under data/tmp/masks. */
export interface MaskSaveResult {
  maskPath: string
  initPath?: string
}

export interface GenProgress {
  sessionId: string
  messageId: string
  status: 'running' | 'done' | 'stopped' | 'error'
  step?: number
  totalSteps?: number
  image?: ChatImage
  /** short toast-friendly failure line; the full detail lands in data/logs/latest.log */
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

// ---------- tokens (data/hub-tokens.json) ----------
/** A token entry returned by the tokens:list IPC. */
export interface TokenEntry {
  /** Full key (e.g. "huggingface:unsloth/Qwen-Image-2.1-GGUF" or "huggingface:*") */
  key: string
  /**
   * Masked token — first 4 chars + "…" + last 4 chars (e.g. "hf_x…abcd");
   * 8 bullets when the token is ≤12 chars. Raw token values NEVER reach the
   * renderer through the list.
   */
  maskedToken: string
  /** "exact", "partial-wildcard", or "full-wildcard" */
  patternType: 'exact' | 'partial-wildcard' | 'full-wildcard'
  /** Source name extracted from the key (e.g. "huggingface") */
  source: string
  /** Repo pattern extracted from the key (e.g. "unsloth/Qwen-Image-2.1-GGUF" or "*" or "unsloth/*") */
  repoPattern: string
}

/** Payload for tokens:add. */
export interface TokenEntryInput {
  /** Source name (e.g. "huggingface") */
  source: string
  /** Repo pattern (e.g. "unsloth/Qwen-Image-2.1-GGUF", "unsloth/*", or "*") */
  repoPattern: string
  /** Token value (e.g. "hf_xxxxxxxxxxxx") */
  token: string
}

/** Result of a tokens:add or tokens:update operation. */
export interface TokenEntryResult {
  key: string
  maskedToken: string
}

/**
 * Result of a tokens:importFile operation. `errors` and `skipped` are
 * mutually exclusive: an entry with a specific problem is counted in
 * `errors` (and NOT in `skipped`); `skipped` counts only entries ignored
 * without a message (blank/non-string token values).
 */
export interface TokenImportResult {
  added: number
  updated: number
  errors: string[]
  skipped: number
}
