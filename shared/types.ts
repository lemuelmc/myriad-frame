/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Shared types used by main, preload and renderer.

export type ModelType =
  | 'diffusion'
  | 'encoder'
  | 'vae'
  | 'vision'
  | 'lora'
  | 'tokenizer'
  | 'audio_encoder'
  | 'audio_vae'
  | 'latent_upscaler'
  | 'llm'
  | 'pixel_upscaler'
  | 'adetailer'
  | 'ip_adapter'
  | 'clip_vision'
  | 'control_net'

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

/** A diffusion model definition from hub.json (top-level model_families array). */
export interface HubDiffusionModel {
  name: string
  label: string
  /** inference type (e.g. 'text_to_image', 'video', 'image_to_video') */
  type: string
  /** legacy optional mode field — the shipped hub.json no longer carries it */
  mode?: string
  /**
   * Upstream access requirement for the family's repos: 'auth' = downloads
   * require an API token, 'gated' = a token PLUS accepting the terms/license
   * on the model page. Absent/null = freely downloadable. Surfaced as an
   * accent badge in the model picker and Settings → Models, read from the
   * FRESH hub config (`accessForFamily()` in renderer deps.ts) so a newly
   * configured family badges without a catalog rescan.
   */
  access?: 'auth' | 'gated' | null
}

/**
 * hub.json `inference_types` — per-inference-type composer metadata
 * (e.g. `text_to_video: { text_input: true, accepts: null }`). Informational:
 * the sampling.json per-type channels are the operative gates.
 */
export type HubInferenceTypes = Record<
  string,
  { text_input: boolean; accepts: string[] | null }
>

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
  /** family this model belongs to (e.g. 'qwen_image_2_1', 'z_image') */
  family: string
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
  /**
   * `requires` block: the diffusion family each companion model resolves
   * from, instead of the session's own diffusionType (e.g. a
   * `wan2_2_t2v` entry requires the `wan2_1` VAE + encoder). Absent keys
   * resolve from the entry's own diffusion_type.
   *
   * EVERY kind accepts BOTH the scalar `{ from }` form (one companion file,
   * emitted under the kind's default CLI flag — see
   * `COMPANION_USE_AS_DEFAULTS`) and the ARRAY of `{ from, use_as }` pairs
   * form — one entry per companion file to emit (e.g. hunyuan_video_1_5 needs
   * a `qwen2_5_vl_7b_instruct` file as `--llm` AND a `byt5_small_glyphxl`
   * file as `--t5xxl`, each from a different family).
   */
  requires?: {
    vae?:             { from: string } | { from: string; use_as: string }[]
    encoder?:         { from: string } | { from: string; use_as: string }[]
    audio_encoder?:   { from: string } | { from: string; use_as: string }[]
    vision?:          { from: string } | { from: string; use_as: string }[]
    tokenizer?:       { from: string } | { from: string; use_as: string }[]
    audio_vae?:       { from: string } | { from: string; use_as: string }[]
    latent_upscaler?: { from: string } | { from: string; use_as: string }[]
  }
  /**
   * Static multi-file catalog (WAN MoE pairs): one item = one selectable
   * quant = the LOW-NOISE expert plus (optionally) its HIGH-NOISE partner.
   * When present the hub scan is skipped entirely and one catalog row is
   * emitted per item file (stamped `useAs` + `groupId`).
   */
  catalog?: HubDiffusionCatalogItem[]
}

/** One selectable quant of a diffusion `catalog[]` entry (MoE pair). */
export interface HubDiffusionCatalogItem {
  /** group id — shared by every file of the same quant (e.g. `..._q4_k_m`) */
  name: string
  /** human-readable label (e.g. "QuantStack/Wan2.2-T2V-A14B Q4_K_M") */
  label: string
  /** the files of this quant and the CLI slot each is passed under */
  items: { file: string; use_as: string }[]
}

/** The closed set of diffusion `catalog[].items[].use_as` values (hub.json). */
export const DIFFUSION_USE_AS = ['diffusion-model', 'high_noise_diffusion_model'] as const

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
   * Entry-level flag name for the SINGLE-file (`default`) shape (e.g.
   * `t5xxl` for the wan umt5-xxl encoder) — when set, the default encoder is
   * emitted as `--<use_as> <path>` instead of `--llm`. Ignored on bundle
   * entries (each `defaults[]` item carries its own `use_as`).
   */
  use_as?: string
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

/** IP Adapter entry from hub.json repo.ip_adapter — a downloadable adapter weight.
 *  Same shape as LoRA entries but keyed by `families` (the loop's actual expansion key). */
export interface HubIpAdapterEntry {
  provider: string
  label: string
  description?: string
  url: string
  path?: string
  /** optional CivitAI version filter (same rule as diffusion entries) */
  model_version_ids?: number[]
  /** optional pagination cap (HuggingFace entries; same rule as diffusion entries) */
  max_page?: number
  families: string[]
  /** optional model-source override (same semantics as diffusion entries) */
  source?: string
  /** optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}
export type HubClipVisionEntry = HubIpAdapterEntry

/** Control Net entry from hub.json repo.control_net — a downloadable control net weight.
 *  Same shape as IP-Adapter entries but `families` is OPTIONAL (control_net
 *  entries are LoRA-style global: no family scoping, the dialog shows ALL). */
export interface HubControlNetEntry {
  provider: string
  label: string
  description?: string
  url: string
  path?: string
  /** optional CivitAI version filter (same rule as diffusion entries) */
  model_version_ids?: number[]
  /** optional pagination cap (HuggingFace entries; same rule as diffusion entries) */
  max_page?: number
  /** LoRA-style global — control_net entries legitimately have no families key */
  families?: string[]
  /** optional model-source override (same semantics as diffusion entries) */
  source?: string
  /** optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** LoRA entry from hub.json repo.lora — a downloadable LoRA adapter repo
 *  (CivitAI model page or HuggingFace repo). Unlike the other repo sections,
 *  a lora entry serves MULTIPLE diffusion types (`families[]`) and has
 *  no `default` file — every scanned file is a catalog row. */
export interface HubLoraEntry {
  /** provider key (e.g. 'captain_daddy') — recorded on entries + the download registry */
  provider: string
  /** human-readable label (e.g. 'ENI Pattern') */
  label: string
  /** short description shown in the LoRA browser */
  description?: string
  /** diffusion types this LoRA is offered for */
  families: string[]
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

/** Pixel-upscaler entry from hub.json repo.pixel_upscaler — a GROUP → ARRAY map
 *  (unlike audio_vae/latent_upscaler which map a diffusionType to a single
 *  entry). The group key (e.g. 'esregan') is the catalog family used for the
 *  family-scoped on-disk layout and `pathFor` resolution; every scanned file
 *  of the repo is a catalog row, with `default` naming the file that MUST be
 *  present on first launch (background download). */
export interface HubPixelUpscalerEntry {
  /** provider key (e.g. 'wbruna') — selects the download subdirectory */
  provider?: string
  /** human-readable label (e.g. 'Wagner Bruna/ESREGAN') */
  label?: string
  /** short description shown in Settings → Upscaler */
  description?: string
  url: string
  /** optional repo-relative folder restriction — same grammar as diffusion entries ('/' = repo-root direct children, absent = whole repo) */
  path?: string
  /** repo-relative file path (or full URL) of the default upscaler model */
  default: string
  /** Optional model-source override (same semantics as the other repo sections). */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** ADetailer (YOLOv8 object detector) entry from hub.json repo.adetailer. */
export interface HubAdetailerEntry {
  /** provider key (e.g. 'exe_ai_harness') — selects the download subdirectory */
  provider: string
  /** human-readable label (e.g. 'Exe AI/ADetailer YOLOv8') */
  label: string
  /** short description shown in Settings → Adetailer */
  description?: string
  /** HuggingFace repo URL */
  url: string
  /** optional repo-relative folder restriction — same grammar as diffusion entries ('/' = repo-root direct children, absent = whole repo) */
  path?: string
  /** optional model-source override (same semantics as the other repo sections). */
  source?: string
  /** optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** Audio-encoder entry from hub.json repo.audio_encoder (e.g. wav2vec2 for Wan2.2 S2V). */
export interface HubAudioEncoderEntry {
  /** provider key (e.g. 'comfy_org') — selects the download subdirectory */
  provider?: string
  label?: string
  url: string
  /** repo-relative file path (or full URL) of the audio encoder */
  default: string
  /** Optional model-source override (same semantics as the other repo sections). */
  source?: string
  /** Optional domain override (see `source`); `source` wins when both are set. */
  domain?: string
}

/** One LLM type definition from hub.json (top-level llm_models array). */
export interface HubLlmModel {
  /** machine name (e.g. 'gemma_3_1b_it') — the catalog family key */
  name: string
  /** human-readable label (e.g. 'Gemma 3 1B IT') */
  label: string
}

/** One selectable quant of an LLM `catalog[]` entry. */
export interface HubLlmCatalogItem {
  /** group id — the catalog ITEM name (e.g. `unsloth_gemma_3_1b_it_q4_k_m`) */
  name: string
  /** human-readable label (e.g. 'Unsloth/Gemma-3 IT @q4km') */
  label: string
  /** the GGUF files of this item (an EXPLICIT list — no repo scan) */
  items: { file: string }[]
}

/** Provider entry from hub.json repo.llm.models — an explicit-file-list LLM repo. */
export interface HubLlmEntry {
  /** LLM type key (e.g. 'gemma_3_1b_it') — the family-scoped destination dir */
  llm_type: string
  /** quantization container type (e.g. 'gguf') */
  quant_type: string
  /** HuggingFace repo URL (tree URL) */
  url: string
  /** optional repo-relative folder restriction (informational for v1 — the catalog is explicit) */
  path?: string
  /** the selectable catalog items, each an explicit file list */
  catalog: HubLlmCatalogItem[]
}

/** hub.json repo.llm.default — the default enhancer configuration. */
export interface HubLlmDefault {
  /** LLM type key (e.g. 'gemma_3_1b_it') */
  llm_type: string
  /** provider key of the default model (e.g. 'unsloth') */
  provider: string
  /** default catalog ITEM name (e.g. 'unsloth_gemma_3_1b_it_q4_k_m') — NOT a file basename */
  model: string
  /** flash attention: 'on' | 'off' */
  flash_attention: 'on' | 'off'
  /** K-cache type (e.g. 'q8_0', 'f16') */
  k_cache: string
  /** V-cache type (e.g. 'q8_0', 'f16') */
  v_cache: string
  /** context size (-c) */
  context_size: number
  /** eval batch size (-b) */
  eval_batch_size: number
  /** chunk batch size (-ub) */
  chunk_batch_size: number
  /** sampling temperature (--temp) */
  temp: number
  /** min-p sampling (--min-p) */
  min_p: number
  /** top-p sampling (--top-p) */
  top_p: number
  /** top-k sampling (--top-k) */
  top_k: number
  /** repeat penalty (--repeat-penalty) */
  repeat_penalty: number
}

/** The hub.json repo.llm section (LLM prompt enhancer). Optional — older overrides lack it. */
export interface HubLlmSection {
  /** prompt id -> default system prompt (the enhancer reads the 'llm' key) */
  system_prompts?: Record<string, string>
  /** provider key -> LLM repo entry (explicit catalog, no repo scan) */
  models?: Record<string, HubLlmEntry>
  /** the default enhancer configuration (resolved through the catalog) */
  default?: HubLlmDefault
}

export interface HubConfig {
  /** "last updated" marker carried by the file (and the override) as-is */
  updatedOn: string
  /** top-level model family definitions */
  model_families: HubDiffusionModel[]
  /** available model providers */
  providers: HubProvider[]
  /** per-inference-type composer metadata; optional (older overrides lack it) */
  inference_types?: HubInferenceTypes
  /** top-level LLM type definitions (the prompt enhancer); optional — older overrides lack it */
  llm_models?: HubLlmModel[]
  repo: {
    /** diffusionType -> VAE repo + default file; the legacy plain-URL form is still accepted at runtime */
    vae: Record<string, HubVaeEntry | string>
    /** diffusionType -> encoder repo + default file (single-file `default`) or encoder bundle (`defaults[]`) */
    encoder: Record<string, HubEncoderEntry>
    /** diffusionType -> vision (mmproj) repo + default file, when the diffusion_type needs a vision model; absent when none does */
    vision?: Record<string, HubVisionEntry>
    /** diffusionType -> tokenizer repo + default file, when the diffusion_type needs a tokenizer; absent when none does */
    tokenizer?: Record<string, HubTokenizerEntry>
    /** diffusionType -> audio encoder (wav2vec2) repo + default file (Wan2.2 S2V); absent when none does */
    audio_encoder?: Record<string, HubAudioEncoderEntry>
    /** diffusionType -> audio VAE repo + default file (LTX 2.5 audio track); absent when none does */
    audio_vae?: Record<string, HubVaeEntry>
    /** diffusionType -> latent upscaler repo + default file (LTX 2.5 hires fix); absent when none does */
    latent_upscaler?: Record<string, HubVaeEntry>
    /** GROUP -> array of pixel-upscaler repo entries (ESRGAN via `sd-cli -M upscale`); absent when none configured */
    pixel_upscaler?: Record<string, HubPixelUpscalerEntry[]>
    /** list of downloadable diffusion model quantizations */
    diffusion: HubDiffusionEntry[]
    /** downloadable LoRA adapters; optional so older hub.json overrides without it stay valid */
    lora?: HubLoraEntry[]
    /** LLM (prompt-enhancer) repos + defaults; optional so older hub.json overrides without it stay valid */
    llm?: HubLlmSection
    /** ADetailer (YOLOv8 object detector) models — single family, no diffusion-type variation */
    adetailer?: {
      /** the default model to download on first launch */
      default?: { provider: string; file: string }
      /** downloadable model entries */
      models?: HubAdetailerEntry[]
    }
    /** downloadable IP Adapter weights; optional so older hub.json overrides without it stay valid */
    ip_adapter?: HubIpAdapterEntry[]
    /** downloadable CLIP-Vision encoders; optional so older hub.json overrides without it stay valid */
    clip_vision?: HubClipVisionEntry[]
    /** downloadable Control Net weights; optional so older hub.json overrides without it stay valid */
    control_net?: HubControlNetEntry[]
  }
}

// ---------- configurations/sampling.json ----------

/**
 * A sampling.json value descriptor: `show` gates the per-session override row
 * (NEVER the default emission) and `default` is the effective value when no
 * override is set.
 */
export interface SamplingField<T> {
  show: boolean
  default: T
}

/**
 * A sampling.json input-channel descriptor: `show` gates the composer button,
 * `max` caps the channel and `accepts` (glob list or null) feeds the file
 * picker filters.
 */
export interface SamplingChannel {
  show: boolean
  max: number
  accepts: string[] | null
}

/** One sampling.json per-diffusion_type entry (descriptor shape). */
export interface SamplingDefaults {
  /** generation mode: 'img_gen' (default, no -M flag) or 'vid_gen' (-M vid_gen) */
  mode: 'img_gen' | 'vid_gen'
  /** how the model file is passed to sd-cli: 'standalone' (default) passes
   *  weights-only files via `--diffusion-model`, with conditioners/VAE as
   *  separate files; 'all_in_one' passes a full checkpoint (conditioners +
   *  VAE inside the file) via `--model` */
  diffusion_behavior: 'all_in_one' | 'standalone'
  /** reference images — repeatable `--ref-image` */
  image_reference: SamplingChannel
  /** explicit input images — single `--init-img` (+ `--strength`) */
  image_input: SamplingChannel
  /** end image — `--end-img` (FLF2V); dormant while every entry has show:false */
  end_image_input: SamplingChannel
  /** driving audio — `--audio` (Wan2.2 S2V) */
  audio_input: SamplingChannel
  /** reference audio — repeatable `--ref-audio` (MiniMax-H3 Ref2VA standalone WAV
   *  reference) */
  audio_reference: SamplingChannel
  /** control video — `--control-video` (VACE; a frames DIRECTORY, not a file) */
  video_input: SamplingChannel
  /** reference video — repeatable `--ref-video` (MiniMax-H3 Ref2VA reference video
   *  frame directory at 24 fps; a frames DIRECTORY, not a media file — the
   *  `accepts` globs are informational for this channel) */
  video_reference: SamplingChannel
  /** video frame count — `--video-frames` (vid_gen only; sd-cli default 1) */
  frames: SamplingField<number | null> & { max: number }
  /** video frame rate — `--fps` (vid_gen only; sd-cli default 24) */
  frame_rate: SamplingField<number | null> & { max: number }
  /** VACE control-frames directory override (informational; the composer picks the dir) */
  control_video: SamplingField<string | null>
  /** denoise strength for img2img runs — emitted as `--strength` only
   *  alongside the init image (sd-cli default 0.75) */
  strength: SamplingField<number>
  /** sample steps; `null` default ⇒ no `--steps` flag (sd-cli default 20) */
  steps: SamplingField<number | null>
  /** high-noise expert steps — `--high-noise-steps` (MoE pairs only) */
  high_steps: SamplingField<number | null>
  cfg: SamplingField<number>
  /** high-noise expert CFG — `--high-noise-cfg-scale` (MoE pairs only) */
  high_cfg: SamplingField<number | null>
  sampler: SamplingField<string>
  /** high-noise expert sampler — `--high-noise-sampling-method` (MoE pairs only) */
  high_sampler: SamplingField<string | null>
  scheduler: SamplingField<string | null>
  width: SamplingField<number>
  height: SamplingField<number>
  negative: SamplingField<string | null>
  /** flow-model shift; `null` default ⇒ no `--flow-shift` flag (sd-cli auto) */
  flow_shift: SamplingField<number | null>
  /** inpainting / outpainting support (composer Inpaint/Outpaint buttons) */
  allow_inpainting: { show: boolean }
  /** paint-tool support (composer Paint button) */
  allow_painting: { show: boolean }
  /** previous-image chaining (composer 'Use previous image' checkbox):
   *  `show` gates the checkbox + its As input/As Reference dropdown and
   *  `default` is the checkbox's initial checked state */
  use_previous_image: SamplingField<boolean>
  /** LTX spatial-latent upscale master switch — `--hires` (hires fix) */
  upscale: SamplingField<boolean>
  /** ADetailer (YOLOv8 object-detector repair pass) — `show` gates the
   *  composer ADetailer button (configurations/sampling.json) */
  adetailer: { show: boolean }
  /** IP Adapter support — `show` gates the composer IP Adapter button */
  ip_adapter: { show: boolean }
  /** Control Net support — `show` gates the composer Control Net button */
  control_net: { show: boolean }
  /** highres-fix second-pass steps — `--hires-steps`; `null` ⇒ omit the flag
   *  (sd-cli default 0 = reuse `--steps`) */
  upscaler_steps: SamplingField<number | null>
  /** arbitrary key=value model args — `--model-args`; `null` ⇒ omit the flag
   *  (sd-cli default); `show` gates the per-session override row */
  model_args: SamplingField<string | null>
}

export type SamplingConfig = Record<string, SamplingDefaults>

/**
 * Flat scalar override shape — what `settings.json` (per-type sampling
 * overrides) and the session file (`session.inputs.sampling`) store. Values
 * merge into the matching descriptor's `default`; absent keys keep the
 * sampling.json config. The same merge lives in main's `effectiveSampling()`
 * and the renderer's `samplingFor()` — both must stay descriptor-aware.
 */
export interface SamplingOverrideValues {
  steps?: number | null
  high_steps?: number | null
  /** null ⇒ the whitelist DELETES the key = inherit (a null descriptor
   *  default ⇒ the flag is omitted at spawn) */
  cfg?: number | null
  high_cfg?: number | null
  strength?: number | null
  sampler?: string | null
  high_sampler?: string | null
  scheduler?: string
  /** finite number (incl 0) ⇒ `--flow-shift`; ''/null ⇒ no flag */
  flow_shift?: number | '' | null
  frames?: number | null
  frame_rate?: number | null
  /** per-type negative prompt override ('' = inherit) */
  negative?: string | null
  width?: number
  height?: number
  /** finite integer in [0, SEED_MAX] ⇒ fixed `--seed`; null/absent ⇒ random per run */
  seed?: number | '' | null
  /** LTX spatial-latent upscale master switch (checkbox; blank ⇒ false) */
  upscale?: boolean
  /** highres-fix second-pass steps; finite ≥ 0 stores as-is (0 ≡ reuse `--steps`);
   *  null/'' ⇒ `--hires-steps` omitted */
  upscaler_steps?: number | null
  /** free-form `--model-args` string (key=value list); ''/null ⇒ no flag */
  modelArgs?: string | null
  /** session-only universal sd-cli arguments (raw CLI string, e.g.
   *  `--flow-match on --cfg-rescale 0.7`); parsed into tokens at spawn and
   *  appended after all app-emitted flags (user args win on duplicates).
   *  ''/null ⇒ nothing appended */
  args?: string | null
}

/**
 * The descriptor-shaped fallback for a diffusion type missing from
 * sampling.json — and, more importantly, the COMPLETION BASE every merge
 * site spreads a configured entry over: gen:start reads every channel/value
 * descriptor UNGUARDED (`sampling.X.show`), so an entry that predates a
 * descriptor key (e.g. boogu_image lacking `control_video`) must be completed
 * or the generation crashes with "Cannot read properties of undefined".
 * Every channel closed, img_gen, sd-cli-default sampling values.
 */
export const FALLBACK_SAMPLING: SamplingDefaults = {
  mode: 'img_gen',
  diffusion_behavior: 'standalone',
  image_reference: { show: false, max: 0, accepts: null },
  image_input: { show: false, max: 0, accepts: null },
  end_image_input: { show: false, max: 0, accepts: null },
  audio_input: { show: false, max: 0, accepts: null },
  audio_reference: { show: false, max: 0, accepts: null },
  video_input: { show: false, max: 0, accepts: null },
  video_reference: { show: false, max: 0, accepts: null },
  frames: { show: false, max: 0, default: 0 },
  frame_rate: { show: false, max: 0, default: 0 },
  control_video: { show: false, default: null },
  strength: { show: true, default: 0.75 },
  steps: { show: true, default: 25 },
  high_steps: { show: false, default: null },
  cfg: { show: true, default: 1.0 },
  high_cfg: { show: false, default: null },
  sampler: { show: true, default: 'euler' },
  high_sampler: { show: false, default: null },
  scheduler: { show: true, default: null },
  width: { show: true, default: 1024 },
  height: { show: true, default: 1024 },
  negative: { show: true, default: null },
  flow_shift: { show: true, default: null },
  allow_inpainting: { show: false },
  allow_painting: { show: false },
  use_previous_image: { show: false, default: false },
  upscale: { show: false, default: false },
  upscaler_steps: { show: false, default: null },
  adetailer: { show: false },
  ip_adapter: { show: false },
  control_net: { show: false },
  model_args: { show: false, default: null }
}

/** Merge flat scalar overrides into a descriptor record (shared semantics). */
export function applySamplingOverrides(
  base: SamplingDefaults,
  overrides: SamplingOverrideValues | null | undefined
): SamplingDefaults {
  const out: SamplingDefaults = { ...base }
  const o = overrides ?? {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  if (o.steps !== undefined) out.steps = { ...out.steps, default: o.steps }
  if (o.high_steps !== undefined) out.high_steps = { ...out.high_steps, default: o.high_steps }
  if (num(o.cfg) !== undefined) out.cfg = { ...out.cfg, default: o.cfg as number }
  if (o.high_cfg !== undefined) out.high_cfg = { ...out.high_cfg, default: o.high_cfg }
  if (num(o.strength) !== undefined) out.strength = { ...out.strength, default: o.strength as number }
  if (typeof o.sampler === 'string' && o.sampler.trim()) out.sampler = { ...out.sampler, default: o.sampler }
  if (o.high_sampler !== undefined) out.high_sampler = { ...out.high_sampler, default: o.high_sampler }
  if (typeof o.scheduler === 'string' && o.scheduler.trim()) out.scheduler = { ...out.scheduler, default: o.scheduler }
  if (o.flow_shift !== undefined) out.flow_shift = { ...out.flow_shift, default: o.flow_shift as number | null }
  if (o.frames !== undefined) out.frames = { ...out.frames, default: o.frames }
  if (o.frame_rate !== undefined) out.frame_rate = { ...out.frame_rate, default: o.frame_rate }
  if (typeof o.negative === 'string') out.negative = { ...out.negative, default: o.negative }
  else if (o.negative === null) out.negative = { ...out.negative, default: null }
  if (num(o.width) !== undefined) out.width = { ...out.width, default: o.width as number }
  if (num(o.height) !== undefined) out.height = { ...out.height, default: o.height as number }
  // upscale: checkbox semantics — the payload crosses IPC as untyped JSON, so
  // read the raw value as unknown before comparing. A PRESENT value always
  // normalizes to a definite boolean ('checked'/'true' → true, everything
  // else → false); absent ⇒ no override, descriptor default stands.
  const rawUpscale = (o as { upscale?: unknown }).upscale
  if (rawUpscale !== undefined) {
    out.upscale = {
      ...out.upscale,
      default: rawUpscale === true || rawUpscale === 'checked' || rawUpscale === 'true'
    }
  }
  // upscaler_steps: a finite number ≥ 0 stores as-is (0 ≡ "reuse --steps",
  // same effect as omitting the flag); null / '' (empty string ≡ null for
  // safety) / any other non-number ⇒ null (⇒ --hires-steps omitted); absent
  // ⇒ no override.
  const rawUpscalerSteps = (o as { upscaler_steps?: unknown }).upscaler_steps
  if (rawUpscalerSteps !== undefined) {
    out.upscaler_steps = {
      ...out.upscaler_steps,
      default:
        typeof rawUpscalerSteps === 'number' && Number.isFinite(rawUpscalerSteps) && rawUpscalerSteps >= 0
          ? rawUpscalerSteps
          : null
    }
  }
  // model_args: a non-empty trimmed string overrides; '' / null ⇒ no override
  // (descriptor default stands ⇒ the flag is omitted at spawn). Absent ⇒ no
  // override.
  const rawModelArgs = (o as { modelArgs?: unknown }).modelArgs
  if (rawModelArgs !== undefined) {
    const trimmed = typeof rawModelArgs === 'string' ? rawModelArgs.trim() : ''
    out.model_args = { ...out.model_args, default: trimmed ? trimmed : null }
  }
  return out
}

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
  /** authoring metadata — display label from resolution.json (`name` mirrors it at runtime) */
  label?: string
  /** authoring metadata — aspect string such as "16:9" */
  aspect?: string
  /** authoring metadata — "landscape" | "portrait" | "none" (square) */
  orientation?: 'landscape' | 'portrait' | 'none'
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

/** version (e.g. "1053") -> runtime key -> download url */
export type RuntimeReleases = Record<string, Partial<Record<RuntimeKey, string>>>

/**
 * Shape of `configurations/runtime.json` (and the `data/runtime.json`
 * override): an `updatedOn` marker plus the `releases` map of version ->
 * runtime key -> download url. Legacy flat overrides (version keys at the
 * top level, written before the `releases` wrapper) are accepted by
 * `validateRuntimeConfig` and wrapped into this shape by
 * `normalizeRuntimeConfig` at load time.
 */
export interface RuntimeConfig {
  /** "last updated" marker carried by the file (and the override) as-is */
  updatedOn: string
  /** version (e.g. "1053") -> runtime key -> download url */
  releases: RuntimeReleases
}

// ---------- configurations/ffmpeg.json ----------
/**
 * One per-platform ffmpeg download entry. `archive` selects the extraction
 * strategy: `zip` (Windows/macOS) or `tar.xz` (Linux — Node has no built-in
 * xz support, so extraction shells out to `tar -xf`).
 */
export interface FfmpegPlatformEntry {
  /** static ffmpeg build URL; empty string = no build for this key */
  url: string
  archive: 'zip' | 'tar.xz'
}

/**
 * Shape of `configurations/ffmpeg.json`: per-platform download URLs for
 * static ffmpeg builds. Key resolution order is `<platform>_<arch>` first
 * (e.g. `macos_arm64`), then the generic platform key (`macos`).
 */
export interface FfmpegConfig {
  updatedOn: string
  platforms: Record<string, FfmpegPlatformEntry>
}

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
  /** Debug flags — only active when present in configurations/application.json */
  debug?: {
    /** When true, enables the sd-cli command preview (gen:preview) in the composer */
    preview?: boolean
  }
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
   * MoE group id (diffusion `catalog[]` entries only) — shared by every file
   * of one quant (the low-noise primary + its high-noise companion). The
   * picker groups rows by it and gen:start derives the high-noise companion
   * from it.
   */
  groupId?: string
  /**
   * The hub.json diffusion entry's `name` (e.g. `comfy_org_boogu_image`) —
   * stamped by buildCatalog on every diffusion row. This is the key a session
   * saves as `diffusionName` so the entry's hub configuration (its
   * `requires` block, path restriction, version filter…) can be looked up
   * directly even when a family maps to several hub entries.
   */
  hubName?: string
  /**
   * Resolved `requires` from-family names (diffusion entries only) — the
   * family each companion model resolves from instead of the entry's own
   * diffusion_type. Absent keys resolve from the entry's diffusionType.
   *
   * EVERY kind is either a plain family `string` (the scalar form — one
   * companion file under the kind's default CLI flag) or an array of
   * `{ from, useAs }` descriptors (one companion file per item, each from its
   * own family, each emitted under its own flag). `requiresFrom()` in hub.ts
   * collapses a single-item array whose `use_as` is the kind default to the
   * plain string; custom-`use_as` and multi-item arrays stay arrays.
   */
  requires?: {
    vae?:             string | { from: string; useAs: string }[]
    encoder?:         string | { from: string; useAs: string }[]
    audio_encoder?:   string | { from: string; useAs: string }[]
    vision?:          string | { from: string; useAs: string }[]
    tokenizer?:       string | { from: string; useAs: string }[]
    audio_vae?:       string | { from: string; useAs: string }[]
    latent_upscaler?: string | { from: string; useAs: string }[]
  }
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
  /** total generation time in ms (spawn → done, incl. any ffmpeg conversion);
   *  emitted only on the terminal 'done' progress event; optional on legacy
   *  sessions that predate this field */
  durationMs?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** generated image or video (assistant; Motion-JPEG .avi for vid_gen runs) */
  image?: ChatImage
  /** reference image paths (user) */
  refs?: string[]
  /** driving audio path (S2V) — display-only */
  audioPath?: string
  /** reference audio paths (--ref-audio) — display-only */
  audioReferencePaths?: string[]
  /** control-frames directory path (VACE) — display-only */
  controlVideoPath?: string
  /** end image path (FLF2V) — display-only */
  endImagePath?: string
  /** reference video frame directories (--ref-video) — display-only */
  videoReferencePaths?: string[]
  status?: 'ok' | 'stopped' | 'error'
  /** legacy only — raw error text is no longer persisted or rendered; errors live in the log + toasts */
  error?: string
  createdAt: number
}

/** Composer inputs a session remembers. Optional — legacy session files lack it. */
/** The sampling values a session may override (flat scalars merged into the
 *  descriptor defaults — see `SamplingOverrideValues`; the width/height rows
 *  are not overridable per session — the resolution selected in the chat
 *  panel always wins). */
/**
 * Per-session sampling override — the flat scalar values a session may
 * override (see `SamplingOverrideValues`). Main merges them into the
 * descriptor defaults at gen:start; the whitelist in sessions.setInputs is
 * strict (an invalid value deletes the key).
 */
export type SessionSamplingOverride = SamplingOverrideValues

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

/** Default IP Adapter strength. */
export const DEFAULT_IP_ADAPTER_STRENGTH = 0.8

/** Per-session IP Adapter settings (session.inputs.ipAdapter). */
export interface SessionIpAdapter {
  /** master switch — false/absent emits NO ip-adapter flags at spawn */
  apply: boolean
  /** basename of the selected IP-Adapter weight file */
  model: string
  /** provider key of the selected adapter (disambiguates same-basename files) */
  provider?: string
  /** basename of the selected CLIP-Vision encoder */
  clipVision?: string
  clipVisionProvider?: string
  /** absolute path of the reference image (--ip-adapter-image) */
  image?: string
  /** --ip-adapter-strength; finite ≥ 0 emitted, absent → sd-cli default 1.0 */
  strength?: number | null
}

/** Per-session Control Net settings (session.inputs.controlNet). */
export interface SessionControlNet {
  /** master switch — false/absent emits NO control-net flags at spawn */
  apply: boolean
  /** basename of the selected control net file */
  model: string
  /** provider key of the selected control net (disambiguates same-basename files) */
  provider?: string
  /** absolute path of the control image (--control-image) */
  image?: string
  /** --control-strength; finite ≥ 0 emitted, absent → sd-cli default 0.9 */
  strength?: number | null
}

/** ADetailer (YOLOv8 object detector repair pass) per-session settings. */
export interface AdetailerSettings {
  enabled: boolean
  model: string  // basename of the selected adetailer model file
  /**
   * provider key of the selected adetailer model. Adetailer detectors can ship
   * under multiple providers with the same basename (e.g. face_yolov8s under
   * several orgs); the provider disambiguates the on-disk slot in the
   * family/provider-scoped pathFor chain and makes the saved selection
   * self-describing, so a reload re-resolves the correct file instead of
   * silently picking whichever provider folder sorts first. Absent (legacy
   * sessions) → main resolves by basename only, as before.
   */
  provider?: string
  /** Optional custom prompt for the ADetailer pass; empty = inherit the main prompt */
  adPrompt: string
  /** Optional custom negative prompt for the ADetailer pass; empty = inherit the main negative prompt */
  adNegativePrompt: string
  inputSize: number | null
  confidence: number | null
  nms: number | null
  maxDetections: number | null
  maskKLargest: number | null
  maskFilterMethod: 'area' | 'confidence' | null  // null = omit
  maskMinRatio: number | null
  maskMaxRatio: number | null
  dilateErode: number | null
  offsetX: number | null
  offsetY: number | null
  maskMode: 'none' | 'merge' | 'merge_invert' | null  // null = omit
  mergeMasks: 'none' | 'true' | 'false' | null  // null = omit
  invertMask: 'none' | 'true' | 'false' | null  // null = omit
  maskBlur: number | null
  inpaintPadding: number | null
  inpaintOnlyMasked: 'none' | 'true' | 'false' | null  // null = omit
  inpaintWidth: number | null
  inpaintHeight: number | null
  denoisingStrength: number | null
  sortBy: 'none' | 'left_to_right' | 'center_to_edge' | 'area' | null  // null = omit
  /** Detail steps (--extra-ad-args `steps`); 0 = inherit main generation (sd-cli range: 1-100) */
  detailSteps: number | null
  /** Detail CFG scale (--extra-ad-args `cfg_scale`); -1 = inherit main generation */
  detailCfg: number | null
  /** Detail sampler name (--extra-ad-args `sample_method`); inherited when null */
  detailSampler: string | null
  /** Detail scheduler name (--extra-ad-args `scheduler`); inherited when null */
  detailScheduler: string | null
  /** CLIP skip (--extra-ad-args `clip_skip`); inherited when null */
  clipSkip: number | null
}

/** Default ADetailer settings. */
export const DEFAULT_ADETAILER_SETTINGS: AdetailerSettings = {
  enabled: false,
  model: '',
  adPrompt: '',
  adNegativePrompt: '',
  inputSize: 640,
  confidence: 0.3,
  nms: 0.45,
  maxDetections: 100,
  maskKLargest: 0,
  maskFilterMethod: null,
  maskMinRatio: 0,
  maskMaxRatio: 1,
  dilateErode: 4,
  offsetX: 0,
  offsetY: 0,
  maskMode: null,
  mergeMasks: null,
  invertMask: null,
  maskBlur: 4,
  inpaintPadding: 32,
  inpaintOnlyMasked: null,
  inpaintWidth: 512,
  inpaintHeight: 512,
  denoisingStrength: 0.4,
  sortBy: null,
  detailSteps: 0,
  detailCfg: -1,
  detailSampler: null,
  detailScheduler: null,
  clipSkip: null
}

export interface SessionInputs {
  /**
   * The selected model FILE name (CatalogEntry.name, e.g.
   * `boogu_image_base_nvfp4.safetensors`) — the primary restore key.
   */
  model?: string
  /**
   * model family of the saved model — the NEW key (same value the legacy
   * field carried). New sessions persist this INSTEAD of `diffusionType`;
   * readers accept BOTH (`family ?? diffusionType`) so legacy session files
   * keep restoring. Always paired with the stored model NAME, which is the
   * primary restore key.
   */
  family?: string
  /** legacy key — superseded by `family`; still read for old session files */
  diffusionType?: string
  /**
   * provider key of the saved diffusion variant — pins the variant across
   * session reloads (with duplicate basenames within a family — e.g. two
   * providers shipping the same quant file name — the name+diffusionType
   * re-resolution could otherwise silently switch variants). Absent for
   * legacy sessions (saved before the field existed) — restore falls back to
   * the first name match.
   */
  modelProvider?: string
  /**
   * The hub.json diffusion entry's `name` for the saved model (e.g.
   * `comfy_org_boogu_image`) — lets the entry's hub configuration (its
   * `requires` block, path restriction, version filter…) be looked up
   * directly even when a family maps to several hub entries. Absent for
   * sessions saved before the field existed (and for picks made from a
   * catalog cache that predates the `hubName` stamp) — lookups then fall
   * back to the family match.
   */
  diffusionName?: string
  /** saved resolution entry */
  resolution?: ResolutionEntry
  /** per-session negative prompt; empty string clears */
  negativePrompt?: string
  /** per-session sampling override; null clears */
  sampling?: SessionSamplingOverride | null
  /** per-session LoRA config; absent = off (no lora flags at spawn); null clears */
  lora?: SessionLora | null
  /** per-session ADetailer settings; absent = disabled, null clears */
  adetailer?: AdetailerSettings | null
  /** per-session IP Adapter settings; absent = disabled, null clears */
  ipAdapter?: SessionIpAdapter | null
  /** per-session Control Net settings; absent = disabled, null clears */
  controlNet?: SessionControlNet | null
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
  /** diffusionType -> audio encoder file name (default audio encoder) */
  defaultAudioEncoder?: Record<string, string>
  /** diffusionType -> audio VAE file name (default audio VAE) */
  defaultAudioVae?: Record<string, string>
  /** diffusionType -> latent upscaler file name (default latent upscaler) */
  defaultLatentUpscaler?: Record<string, string>
  /** diffusionType -> sampling overrides (flat scalars merged into descriptor defaults) */
  sampling?: Record<string, SamplingOverrideValues>
  /** global performance / inference flags (applied to every generation) */
  performance?: PerformanceSettings
  /** renderer theme key (see ThemeKey); applied via documentElement data-theme */
  theme?: ThemeKey
  /** LLM prompt-enhancer settings (model selection + inference overrides) */
  llm?: LlmSettings
  /** ADetailer default model basename — app-wide (not per-session); the Settings → Adetailer "Set Default" button writes this */
  adetailerDefault?: string
  /** Accessibility: font size scale (small | medium | large | extra-large).
   *  Applied via data-font-size attribute on <html>. */
  fontSize?: 'small' | 'medium' | 'large' | 'extra-large'
  /** Accessibility: icon size scale (small | medium | large | extra-large).
   *  Applied via data-icon-size attribute on <html>. */
  iconSize?: 'small' | 'medium' | 'large' | 'extra-large'
  /** Enable/Disable debug messages. Useful for diagnosing issues. When
   *  enabled, the full generated command line and parameters are logged for
   *  sd-cli generation, upscaling, ffmpeg conversion and llama-cli runs. */
  debug?: boolean
}

// ---------- LLM prompt enhancer ----------

/** The user's LLM model selection (settings.llm.model). */
export interface LlmModelSelection {
  /** LLM type key (e.g. 'gemma_3_1b_it') */
  llmType: string
  /** provider key (e.g. 'unsloth') */
  provider: string
  /** the selected catalog ITEM name (CatalogEntry.name — the file basename) */
  model: string
}

/**
 * LLM prompt-enhancer settings (data/settings.json `llm`). Every field is
 * optional: absent keys inherit the hub default (`repo.llm.default` /
 * `repo.llm.system_prompts.llm`). `systemPrompt: null` and a dropped key
 * both mean "inherit the hub default".
 */
export interface LlmSettings {
  /** absent → hub.repo.llm.default resolved through the catalog */
  model?: LlmModelSelection
  /** null/'' → hub default (repo.llm.system_prompts.llm) */
  systemPrompt?: string | null
  /** flash attention: 'on' | 'off' */
  flashAttention?: 'on' | 'off'
  /** K-cache type ('f16' | 'q8_0' | 'q5_1' | 'q4_0' …) */
  kCache?: string
  /** V-cache type */
  vCache?: string
  /** context size (-c) */
  contextSize?: number
  /** eval batch size (-b) */
  evalBatchSize?: number
  /** chunk batch size (-ub) */
  chunkBatchSize?: number
  /** sampling temperature (--temp) */
  temp?: number
  /** min-p sampling (--min-p) */
  minP?: number
  /** top-p sampling (--top-p) */
  topP?: number
  /** top-k sampling (--top-k) */
  topK?: number
  /** repeat penalty (--repeat-penalty) */
  repeatPenalty?: number
}

export type FlashAttentionMode = 'none' | 'on' | 'off' | 'auto' | 'custom'
export type BackendMode =
  | 'off'
  | 'cpu'
  | 'cuda0'
  | 'rocm'
  | 'hipblas'
  | 'sycl0'
  | 'opencl0'
  | 'auto'
  | 'custom'
export type AutoFitMode = 'none' | 'on' | 'off'
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
  /** 'none' omits --flash-attn entirely; 'custom' uses flashAttentionCustom */
  flashAttention: FlashAttentionMode
  /** free-form value used when flashAttention === 'custom' */
  flashAttentionCustom: string
  /** runtime backend; 'off' omits --backend entirely, 'custom' uses backendCustom */
  backend: BackendMode
  /** free-form value used when backend === 'custom' */
  backendCustom: string
  /** emit the valueless --sage-attn flag when true (CUDA builds only) */
  sageAttention: boolean
  /** 'none' omits --auto-fit; otherwise the explicit on/off value */
  autoFit: AutoFitMode
  /** raw --max-vram string (e.g. '6', '-1', 'cuda0=6,vulkan0=2'); empty = omit the flag */
  maxVram: string
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

// ---------- companions (requires) ----------

/** The seven companion kinds a diffusion entry's `requires` block may declare. */
export type CompanionKind =
  | 'vae'
  | 'encoder'
  | 'audio_encoder'
  | 'vision'
  | 'tokenizer'
  | 'audio_vae'
  | 'latent_upscaler'

/**
 * One resolved companion reference: the family the companion file resolves
 * from (`from`) + the CLI flag it is emitted under at spawn (`useAs`).
 */
export interface CompanionRef {
  from: string
  useAs: string
}

/**
 * The natural CLI flag per companion kind when a `requires` item omits
 * `use_as`. NOTE: the latent_upscaler value is IGNORED at spawn — the type
 * derives `--hires-upscalers-dir` + `--hires-upscaler` from the file path;
 * it exists only to keep the shape uniform.
 */
export const COMPANION_USE_AS_DEFAULTS: Record<CompanionKind, string> = {
  vae: 'vae',
  encoder: 'llm',
  audio_encoder: 'audio-encoder',
  vision: 'llm_vision',
  tokenizer: 'tokenizer',
  audio_vae: 'audio-vae',
  latent_upscaler: 'hires-upscaler'
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
  /** provider key of the selected diffusion variant (hub.json) — disambiguates
   *  a basename collision across provider subdirectories within one family */
  modelProvider?: string
  /** the hub.json diffusion entry's `name` of the selected model (e.g.
   *  `comfy_org_boogu_image`) — pins the EXACT entry whose hub configuration
   *  (requires block…) main resolves when a family maps to several entries;
   *  absent → the first family match (the pre-field behavior) */
  diffusionName?: string
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
  /** audio encoder file name (from models dir; Wan2.2 S2V) */
  audioEncoder?: string
  /** audio VAE file name (from models dir; LTX 2.5 audio track) */
  audioVae?: string
  /** audio VAE provider key (hub.json) — disambiguates a basename collision
   *  across provider subdirectories */
  audioVaeProvider?: string
  /** latent upscaler file name (from models dir; LTX 2.5 hires fix) */
  latentUpscaler?: string
  /** latent upscaler provider key (hub.json) — disambiguates a basename collision
   *  across provider subdirectories */
  latentUpscalerProvider?: string
  resolution: { width: number; height: number }
  /** absolute paths of user reference images (--ref-image channel) */
  referencePaths: string[]
  /** absolute paths of user input images (--init-img channel); distinct
   *  from referencePaths (--ref-image channel) */
  inputImagePaths: string[]
  /** driving audio path (--audio; Wan2.2 S2V) */
  audioPath?: string
  /** reference audio paths (--ref-audio; repeatable, MiniMax-H3 Ref2VA) */
  audioReferencePaths?: string[]
  /** control-frames directory path (--control-video; VACE) */
  controlVideoPath?: string
  /** end image path (--end-img; FLF2V) */
  endImagePath?: string
  /** reference video frame directories (--ref-video; repeatable, MiniMax-H3 Ref2VA) */
  videoReferencePaths?: string[]
  /** generation mode: 'vid_gen' ⇒ `-M vid_gen` + the video flags; absent ⇒ img_gen */
  genMode?: 'vid_gen'
  /** video frame count (--video-frames); null/absent ⇒ no flag (sd-cli default 1) */
  frames?: number | null
  /** video frame rate (--fps); null/absent ⇒ no flag (sd-cli default 24) */
  frameRate?: number | null
  /** high-noise expert steps (--high-noise-steps); emitted only when the high-noise model resolved */
  highSteps?: number | null
  /** high-noise expert CFG (--high-noise-cfg-scale); emitted only when the high-noise model resolved */
  highCfg?: number | null
  /** high-noise expert sampler (--high-noise-sampling-method); emitted only when the high-noise model resolved */
  highSampler?: string | null
  /** LTX spatial-latent upscale master switch (--hires); resolved by main from
   *  the merged sampling descriptor — the renderer sends nothing */
  upscale?: boolean
  /** highres-fix second-pass steps (--hires-steps); null/absent ⇒ omit the
   *  flag (sd-cli default 0 = reuse --steps) */
  upscalerSteps?: number | null
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
  /** sample steps; null ⇒ no `--steps` flag (sd-cli default 20 applies) */
  steps: number | null
  /** guidance scale; null ⇒ no `--cfg-scale` flag (sd-cli default 7.0 applies) */
  cfg: number | null
  /** sampling method; null/'' ⇒ no `--sampling-method` flag (sd-cli default:
   *  euler for Flux/SD3/Wan, euler_a otherwise) */
  sampler: string | null
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
  /** raw `--model-args` string (key=value list); empty/omitted ⇒ no flag */
  modelArgs?: string
  /** universal sd-cli arguments (session-only, never a sampling.json field):
   *  the RAW merged value (a concrete string or undefined). Main resolves the
   *  session fallback + normalization; buildArgs parses the string into
   *  whitespace-separated tokens and appends them after all app-emitted flags
   *  (so a duplicate flag the user typed wins over the app's own emission).
   *  Empty/omitted ⇒ nothing appended. */
  args?: string
  /** denoise strength for img2img runs (sampling.json `strength`); null ⇒
   *  no `--strength` flag (sd-cli default 0.75 applies) */
  strength: number | null
  /** global performance flags applied to this generation */
  performance?: Partial<PerformanceSettings>
  /** ADetailer prompt overrides (carried on the generation request so buildArgs() can emit --ad-prompt / --ad-negative-prompt). */
  adetailer?: {
    adPrompt?: string
    adNegativePrompt?: string
  }
  /** IP Adapter settings (carried on the generation request so buildArgs() can emit --ip-adapter flags). */
  ipAdapter?: {
    model: string
    clipVision: string
    image: string
    strength?: number
  }
  /** Control Net settings (carried on the generation request so buildArgs() can emit --control-net flags). */
  controlNet?: {
    model: string
    image: string
    strength?: number
  }
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

/** Renderer → main payload for `resize:save` (ResizeCropOverlay Save). */
export interface ResizeSaveRequest {
  /** PNG data URL — the cropped / resized result (the ORIGINAL file is never touched) */
  png: string
}

/** Result of `resize:save` — the absolute path of the processed PNG under data/tmp/resize. */
export interface ResizeSaveResult {
  path: string
}

/** Renderer → main payload for `upscale:start` (image upscaler). */
export interface UpscaleRequest {
  sessionId: string
  /** absolute path of the source image (must exist) */
  path: string
  /** CatalogEntry.name of the upscaler model */
  model: string
  /** provider key of the upscaler model (hub.json) — disambiguates a basename
   *  collision across provider subdirectories */
  provider?: string
  /** the catalog group key, e.g. 'esregan' — the family-scoped dir */
  diffusionType?: string
  /** ESRGAN tile size (--upscale-tile-size); absent/invalid → 128 (the sd-cli default) */
  tileSize?: number
}

/** Result of `upscale:start` — the upscaled image under data/output/<sessionId>/. */
export interface UpscaleResult {
  path: string
  name: string
}

export interface GenProgress {
  sessionId: string
  messageId: string
  /**
   * `converting` — the vid_gen `.avi` output is being re-encoded to `.mp4`
   * after sd-cli exited (post-processing, not sampling). The renderer keeps
   * the busy indicator up and shows a "Converting…" hint; no step update.
   */
  status: 'running' | 'done' | 'stopped' | 'error' | 'converting'
  step?: number
  totalSteps?: number
  image?: ChatImage
  /** short toast-friendly failure line; the full detail lands in data/logs/latest.log */
  error?: string
  /** total generation time in ms (spawn → done, incl. any ffmpeg conversion);
   *  emitted only on the terminal 'done' status */
  durationMs?: number
}

/**
 * Shape returned by `gen:state` — per-session in-flight generation probe.
 * The renderer rehydrates its per-session busy state from it after a session
 * switch or a dev reload (plans/session-switch-busy-state.md).
 */
export interface GenStateInfo {
  /** true while the session has a generation in flight (sampling or the .avi → .mp4 conversion) */
  running: boolean
  /** true while the post-generation .avi → .mp4 conversion runs (the "Converting…" label) */
  converting: boolean
  /** the in-flight assistant message id (absent when idle) */
  messageId?: string
}

// ---------- platform ----------
export interface PlatformInfo {
  os: 'win32' | 'darwin' | 'linux'
  gpu: 'nvidia' | 'amd' | 'none' | 'unknown'
  gpuDetail?: string
  runtimeKey: RuntimeKey
  /**
   * LLM runtime platform key (llama.cpp build vocabulary — separate from the
   * sd-cli `runtimeKey`), e.g. 'windows_x64_cuda12'. Undefined when the
   * platform has no LLM runtime (the Enhance feature reports that).
   */
  llmRuntimeKey?: string
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
  /**
   * provider key of the directory the file was found in (models.list()
   * classification; e.g. 'unsloth') — undefined for flat / family-root-stray
   * placements. Lets the renderer delete / label a row by its exact location.
   */
  provider?: string
  /**
   * diffusionType (family) of the directory the file was found in
   * (models.list() classification; e.g. 'flux_1') — undefined for legacy
   * per-provider and flat placements.
   */
  diffusionType?: string
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

// ---------- configurations/llm_runtime.json ----------
/**
 * Shape of `configurations/llm_runtime.json`: llama.cpp release archives per
 * platform. `releases` maps a build key (e.g. 'b12207') -> platform key ->
 * archive URL. Platform keys follow `<os>_<arch>_<gpu>`; a `*_lib` companion
 * key (e.g. `windows_x64_cuda12_lib`) carries the cudart DLLs and is
 * extracted into the SAME directory as the main archive.
 */
export interface LlmRuntimeConfig {
  /** "last updated" marker carried by the file as-is */
  updatedOn: string
  /** build key (e.g. 'b12207') -> platform key -> archive URL */
  releases: Record<string, Record<string, string>>
}

/** Result of `llm:enhance` — the enhanced prompt text. */
export interface LlmEnhanceResult {
  text: string
}

/** Shape returned by `llm:status` (Settings → Language Models row + Enhance gating). */
export interface LlmStatusInfo {
  /** selected llama.cpp build key (e.g. 'b12207'); undefined when the platform has no key */
  version?: string
  /** true when the llama-cli binary is installed on disk */
  installed: boolean
  /** the resolved platform key (e.g. 'windows_x64_cuda12'); undefined when the platform has no key */
  platformKey?: string
  /** true when the effective default LLM model file is installed on disk */
  modelInstalled: boolean
}

// ---------- init pipeline ----------
export type InitStage = 'platform' | 'runtime' | 'ffmpeg' | 'llm' | 'catalog' | 'done'

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
