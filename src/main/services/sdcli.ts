/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { GenerationRequest, LoraApplyMode, PerformanceSettings } from '@shared/types'
import { isValidSeed } from '@shared/types'

export interface SdCliPaths {
  model: string
  /** how `model` is passed: 'all_in_one' → full checkpoint via `--model`
   *  (conditioners/VAE inside the file); 'standalone' (default) →
   *  `--diffusion-model` (weights only) */
  modelBehavior?: 'all_in_one' | 'standalone'
  /**
   * WAN MoE high-noise expert — emitted as `--high-noise-diffusion-model`
   * when set; its presence also gates the three `--high-noise-*` sampling
   * flags (a single-expert model never gets stray high-noise flags).
   */
  highNoiseModel?: string
  vae?: string
  encoder?: string
  /** encoder bundle (SD3.5-style): each file + the CLI flag it is passed under */
  encoders?: { path: string; useAs: string }[]
  vision?: string
  /** tokenizer file (e.g. tokenizer.json) — emitted as `--tokenizer` when set */
  tokenizer?: string
  /** wav2vec2 audio encoder — emitted as `--audio-encoder` (Wan2.2 S2V) */
  audioEncoder?: string
  /** LTX audio VAE — emitted as `--audio-vae` (LTX 2.5 audio track) */
  audioVae?: string
  /** ABSOLUTE path of the resolved latent-upscaler model file (LTX 2.5 hires
   *  fix). buildArgs derives `--hires-upscalers-dir` (dirname) and
   *  `--hires-upscaler` (basename minus extension — man.txt:167 wants a
   *  NAME, no path, no extension) from it. */
  latentUpscaler?: string
  /** init image — emitted as `--init-img` when set; sourced from the
   *  input-image channel or the previous image chained "As input"
   *  (see gen:start) */
  initImage?: string
  /** inpaint/outpaint mask — emitted as `--mask` when set; main never sets
   *  `mask` without `initImage` (masks apply to img2img-style runs only) */
  mask?: string
  /**
   * Per-session LoRA config; omitted entirely when the session's mode is
   * 'off' (or unset) — neither flag is emitted then. LoRA SELECTION is
   * prompt-driven (`<lora:filename:weight>` tags in the prompt, resolved by
   * sd-cli against `dir`); these two flags only say WHERE to look and HOW to
   * merge.
   */
  lora?: { dir: string; mode: Exclude<LoraApplyMode, 'off'> }
  references: string[]
  output: string
}

/**
 * Build the sd-cli argument list.
 * Flag names verified against `sd-cli --help` (commit a77d362), the bundled
 * man page (.cached/docs/sd-cli/man.txt) and the official model docs
 * (docs/resolution-qwen-image.md, docs/resolution-zimage.md,
 * .cached/docs/sd-cli/ltx2.md):
 * the diffusion weights go to `--diffusion-model` (or to `--model` when the
 * diffusion type is `all_in_one` — a full checkpoint that already contains
 * conditioners and VAE, so the standalone `--vae` override is skipped), the
 * text encoder to
 * `--llm` (single-file) or to one `--<use_as>` flag per bundle file
 *  (SD3.5-style multi-encoder: `--clip_g`, `--clip_l`, `--t5xxl`), the vision
 *  (mmproj) model to `--llm_vision` (this build has no `--mmproj` flag), the
 *  tokenizer file to `--tokenizer` (when the diffusion type declares one),
 *  the wav2vec2 audio encoder to `--audio-encoder` (Wan2.2 S2V), the LTX
 *  audio VAE to `--audio-vae` (LTX 2.5 audio track),
 *  an optional init image to `--init-img` (input image) together with
 *  `--strength` (the pair is emitted only when the init image is set), a
 *  resolved sigma scheduler to `--scheduler` and a resolved flow-model shift
 *  to `--flow-shift` (each omitted when unset), a fixed seed from the request
 *  to `--seed` (a fresh random seed per run when the request carries none,
 *  since sd-cli's own default is a FIXED 42), the reference images to
 *  repeatable `--ref-image` entries (before `--output`), and the result image
 *  to `--output`.
 *
 * The per-session LoRA config (when the session enabled it) emits
 * `--lora-model-dir` + `--lora-apply-mode`; mode 'off' (or an absent config)
 * emits neither, leaving sd-cli's own defaults untouched.
 *
 * The highres fix (LTX spatial-latent upscale) emits `--hires` when the
 * merged `upscale` sampling value is true, plus `--hires-steps` (only for a
 * positive value — 0/null ⇒ sd-cli default 0 = reuse `--steps`) and, when a
 * latent-upscaler model resolved, `--hires-upscalers-dir` (the file's
 * directory) + `--hires-upscaler` (the file's basename minus extension —
 * man.txt:167 wants a NAME, no path, no extension). Without a resolved
 * upscaler model sd-cli's built-in "Latent" upscaler applies.
 *
 * Performance flags (flash attention, direct conv, VAE tiling, CPU offload,
 * params backend) are appended only when the corresponding setting is enabled.
 */
export function buildArgs(req: GenerationRequest, p: SdCliPaths): string[] {
  // Strip any leading/trailing quotes from the raw prompt so wrapping it in a
  // single pair below never produces a doubled `""...""` collision, then wrap.
  function quotePrompt(prompt: string): string {
    const trimmed = prompt.replace(/^"+/, '').replace(/"+$/, '')
    return `"${trimmed}"`
  }

  // Random seed: 32-bit unsigned integer range, matches sd-cli's seed bounds.
  function randomSeed(): number {
    return Math.floor(Math.random() * 2 ** 32)
  }

  // Video mode: Wan models run under `-M vid_gen` (wan.md: --video-frames
  // alone does NOT select video mode). img_gen types emit no -M flag (sd-cli
  // default img_gen).
  const args: string[] = []
  if (req.genMode === 'vid_gen') args.push('-M', 'vid_gen')
  args.push(
    p.modelBehavior === 'all_in_one' ? '--model' : '--diffusion-model',
    p.model
  )
  // WAN MoE pair: the high-noise expert rides right after the primary.
  if (p.highNoiseModel) args.push('--high-noise-diffusion-model', p.highNoiseModel)
  args.push(
    '--prompt', quotePrompt(req.prompt),
    // Steps: nullable — null/0/negative ⇒ no --steps flag (sd-cli default 20
    // applies); only a positive value is honored.
    ...(typeof req.steps === 'number' && Number.isFinite(req.steps) && req.steps > 0
      ? ['--steps', String(req.steps)]
      : []),
    // CFG scale: nullable — null ⇒ no --cfg-scale flag (sd-cli default 7.0).
    ...(typeof req.cfg === 'number' && Number.isFinite(req.cfg)
      ? ['--cfg-scale', String(req.cfg)]
      : []),
    // Sampling method: nullable — null/'' ⇒ no --sampling-method flag
    // (sd-cli default: euler for Flux/SD3/Wan, euler_a otherwise).
    ...(req.sampler && req.sampler.trim()
      ? ['--sampling-method', req.sampler.trim()]
      : []),
    '--width', String(req.resolution.width),
    '--height', String(req.resolution.height),
    // Fixed seed when the request carries a valid one; otherwise a fresh
    // random seed per run (sd-cli's own default is a FIXED 42, so random
    // mode must keep emitting a seed).
    '--seed', String(isValidSeed(req.seed) ? Math.floor(req.seed) : randomSeed())
  )
  // Video flags — only for vid_gen runs, positive values only (0/null ⇒ the
  // sd-cli default applies: --video-frames 1, --fps 24).
  if (req.genMode === 'vid_gen') {
    if (typeof req.frames === 'number' && Number.isFinite(req.frames) && req.frames > 0) {
      args.push('--video-frames', String(req.frames))
    }
    if (typeof req.frameRate === 'number' && Number.isFinite(req.frameRate) && req.frameRate > 0) {
      args.push('--fps', String(req.frameRate))
    }
  }
  // MoE high-noise sampling values — emitted ONLY when the high-noise expert
  // resolved, so a single-expert type can never carry stray high-noise flags.
  if (p.highNoiseModel) {
    if (typeof req.highSteps === 'number' && Number.isFinite(req.highSteps) && req.highSteps > 0) {
      args.push('--high-noise-steps', String(req.highSteps))
    }
    if (typeof req.highCfg === 'number' && Number.isFinite(req.highCfg)) {
      args.push('--high-noise-cfg-scale', String(req.highCfg))
    }
    if (req.highSampler && req.highSampler.trim()) {
      args.push('--high-noise-sampling-method', req.highSampler.trim())
    }
  }
  // Sigma scheduler — emitted only when the resolved value is a concrete,
  // non-empty string (main resolves the 'model-specific' sentinel to undefined
  // before spawn, so buildArgs() never sees it; null/undefined/'' ⇒ skip).
  if (req.scheduler && req.scheduler.trim()) args.push('--scheduler', req.scheduler.trim())
  // Flow-model shift — emitted only for a finite number (gen:start already
  // normalized the value; 0 is a legal value and must be emitted).
  if (typeof req.flowShift === 'number' && Number.isFinite(req.flowShift)) {
    args.push('--flow-shift', String(req.flowShift))
  }
  // Negative prompt — emitted only when non-empty (sd-cli default is "").
  const neg = req.negativePrompt?.trim()
  if (neg) args.push('--negative-prompt', quotePrompt(neg))
  // Standalone VAE override — skipped for 'all_in_one' types: a full
  // checkpoint carries its own VAE inside the file.
  if (p.vae && p.modelBehavior !== 'all_in_one') args.push('--vae', p.vae)
  // Encoder bundle: each file under its own `--<useAs>` flag (the flag name
  // flows from hub.json `use_as`; sanitize by trimming and stripping leading
  // dashes, skipping empty results). XOR guard — when a bundle is present the
  // legacy single `--llm` emission is skipped, so a malformed request can
  // never emit both.
  if (p.encoders && p.encoders.length > 0) {
    for (const enc of p.encoders) {
      const flag = enc.useAs.trim().replace(/^-+/, '')
      if (!flag) continue
      args.push(`--${flag}`, enc.path)
    }
  } else if (p.encoder) {
    args.push('--llm', p.encoder)
  }
  // Vision (mmproj) model — the projection model that bridges the diffusion
  // transformer to the text encoder. Only emitted when the diffusion_type
  // declares a `vision` dependency in hub.json. Note: this sd-cli build
  // exposes it as `--llm_vision` (there is no `--mmproj` flag).
  if (p.vision) args.push('--llm_vision', p.vision)
  // Tokenizer — emitted only when the diffusion type declares a tokenizer
  // dependency in hub.json (single tokenizer.json path form; the
  // comma-separated assignment form is not used by the app).
  if (p.tokenizer) args.push('--tokenizer', p.tokenizer)
  // Audio encoder — emitted only when the diffusion type resolves one
  // (Wan2.2 S2V's wav2vec2).
  if (p.audioEncoder) args.push('--audio-encoder', p.audioEncoder)
  // Audio VAE — emitted only when the diffusion type resolves one (LTX 2.5
  // generates video WITH an audio track; man.txt:55 "path to standalone LTX
  // audio vae model").
  if (p.audioVae) args.push('--audio-vae', p.audioVae)
  // LoRA — emitted only when the session enabled it. 'off' (or absent) emits
  // NEITHER flag, so sd-cli's own defaults apply untouched. LoRA SELECTION is
  // prompt-driven: the user's prompt carries <lora:filename:weight> tags that
  // sd-cli resolves against this directory — the two flags only tell sd-cli
  // WHERE to look and HOW to merge.
  if (p.lora) {
    args.push('--lora-model-dir', p.lora.dir)
    args.push('--lora-apply-mode', p.lora.mode)
  }
  if (p.initImage) {
    args.push('--init-img', p.initImage)
    // denoise strength — only meaningful with an init image, so the pair is
    // emitted together and txt2img command lines stay free of `--strength`.
    // Nullable: null ⇒ omit the flag (sd-cli default 0.75 applies).
    if (typeof req.strength === 'number' && Number.isFinite(req.strength)) {
      args.push('--strength', String(req.strength))
    }
    // inpaint/outpaint mask — emitted only alongside the init image,
    // mirroring the --init-img/--strength pairing above
    if (p.mask) args.push('--mask', p.mask)
  }
  for (const ref of p.references) args.push('--ref-image', ref)
  // Video-era channels — each flag is single-valued and main only sets it
  // for a type whose sampling.json channel allows it.
  if (req.endImagePath) args.push('--end-img', req.endImagePath)
  if (req.audioPath) args.push('--audio', req.audioPath)
  if (req.controlVideoPath) args.push('--control-video', req.controlVideoPath)
  // Highres fix (LTX spatial-latent upscale) — all flags gated on the merged
  // `upscale` sampling value. `--hires-steps` emits only for a positive value
  // (0/null ⇒ sd-cli default 0 = reuse `--steps`). When a latent-upscaler
  // model resolved, its directory + basename-minus-extension select it
  // (man.txt:167: a built-in name OR a model name under --hires-upscalers-dir
  // — name only, no path, no extension); without one, sd-cli's built-in
  // "Latent" upscaler applies. -W/-H stay the PRE-upscale size: the spatial
  // upsampler produces x2 latent dimensions, so the OUTPUT is 2× the
  // requested size (ltx2.md:93) — --hires-scale/--hires-width/--hires-height
  // stay untouched (sd-cli default scale 2.0 matches).
  if (req.upscale) {
    args.push('--hires')
    if (typeof req.upscalerSteps === 'number' && Number.isFinite(req.upscalerSteps) && req.upscalerSteps > 0) {
      args.push('--hires-steps', String(req.upscalerSteps))
    }
    if (p.latentUpscaler) {
      args.push('--hires-upscalers-dir', dirname(p.latentUpscaler))
      args.push('--hires-upscaler', basename(p.latentUpscaler, extname(p.latentUpscaler)))
    }
  }

  // LTX 2.5: enable flash attention on the diffusion module. Without this
  // flag the generated video comes out all white; --diffusion-fa is the
  // (deprecated) alias for --flash-attn off,diffusion=on. Only emitted when
  // performance settings are disabled (master switch off or absent), since a
  // user who enabled performance controls is steering flash attention there.
  if (req.diffusionType === 'ltx_2_5' && !(req.performance && req.performance.enabled)) {
    args.push('--diffusion-fa')
  }
 
  pushPerformanceArgs(args, req.performance)

  args.push('--output', p.output)
  return args
}

/**
 * Append sd-cli performance flags derived from the (partial) performance
 * settings carried on the generation request. Each flag is emitted only when
 * its setting is meaningfully enabled.
 */
export function pushPerformanceArgs(
  args: string[],
  perf: Partial<PerformanceSettings> | undefined | null
): void {
  if (!perf) return

  // --flash-attn: 'none' omits the flag entirely (sd-cli's own default applies);
  // 'custom' with an empty textbox also emits nothing (never the literal 'custom').
  if (perf.flashAttention && perf.flashAttention !== 'none') {
    if (perf.flashAttention === 'custom' && perf.flashAttentionCustom) {
      args.push('--flash-attn', perf.flashAttentionCustom)
    } else if (perf.flashAttention !== 'custom') {
      args.push('--flash-attn', perf.flashAttention)
    }
  }
  // --backend: 'off' omits the flag; 'custom' uses the free-form value (skip
  // when empty/whitespace — a garbage value would fail sd-cli argument parsing).
  if (perf.backend && perf.backend !== 'off') {
    const backendCustom = (perf.backendCustom ?? '').trim()
    if (perf.backend === 'custom' && backendCustom) {
      args.push('--backend', backendCustom)
    } else if (perf.backend !== 'custom') {
      args.push('--backend', perf.backend)
    }
  }
  // --sage-attn: valueless flag (native CUDA SageAttention with flash/default
  // attention fallback; CUDA builds only).
  if (perf.sageAttention) {
    args.push('--sage-attn')
  }
  // --auto-fit: 'none' omits the flag; on/off are explicit values.
  if (perf.autoFit && perf.autoFit !== 'none') {
    args.push('--auto-fit', perf.autoFit)
  }
  // --max-vram: trimmed non-empty string (a single GiB budget — including
  // negative values — or per-device assignments like 'cuda0=6,vulkan0=2').
  const maxVram = (perf.maxVram ?? '').trim()
  if (maxVram) {
    args.push('--max-vram', maxVram)
  }
  if (perf.convDirect) {
    args.push('--conv-direct', perf.convDirect)
  }
  if (perf.vaeTiling?.tileSize && perf.vaeTiling.tileSize !== 'off') {
    args.push('--vae-tiling')
    args.push('--vae-tile-size', perf.vaeTiling.tileSize)
    args.push('--vae-tile-overlap', String(perf.vaeTiling.overlap))
  }
  if (perf.offloadToCpu === 'on') {
    args.push('--offload-to-cpu')
  }
  if (perf.paramBackend && perf.paramBackend !== 'off') {
    if (perf.paramBackend === 'custom' && perf.paramBackendCustom) {
      args.push('--params-backend', perf.paramBackendCustom)
    } else {
      args.push('--params-backend', perf.paramBackend)
    }
  }
}

import { dataRoot } from './data'

export function outputDir(): string {
  return join(dataRoot(), 'output')
}

export function newOutputPath(
  sessionId: string,
  messageId: string,
  // 'avi' — the bundled runtime's vid_gen writer emits Motion-JPEG AVI
  // (man.txt: single-file video outputs support .avi/.webm/animated .webp;
  // there is no ffmpeg muxer, so .mp4 is NOT writable — sd-cli would APPEND
  // .avi to the requested path instead of honoring it).
  ext: 'png' | 'mp4' | 'avi' = 'png'
): string {
  const dir = join(outputDir(), sessionId)
  mkdirSync(dir, { recursive: true })
  const name = `${messageId}-${Date.now()}.${ext}`
  return join(dir, name)
}

/**
 * Find the most recently modified image file in the session output dir
 * (fallback when the expected output path was not written).
 */
function findLatestImage(sessionId: string): string | undefined {
  const dir = join(outputDir(), sessionId)
  if (!existsSync(dir)) return undefined
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.avi'])
  let best: { p: string; m: number } | undefined
  for (const f of readdirSync(dir)) {
    if (!exts.has('.' + basename(f).toLowerCase().split('.').pop()!)) continue
    const p = join(dir, f)
    const m = statSync(p).mtimeMs
    if (!best || m > best.m) best = { p, m }
  }
  return best?.p
}

export interface GenCallbacks {
  onProgress: (step: number, totalSteps: number) => void
  onLog?: (line: string) => void
  onDone: (imagePath: string) => void
  onError: (message: string) => void
}

// Sampling lines look like `| ... | 1/4 - 34.02s/it - ETA 01:42`; the
// `s/it` suffix distinguishes them from tensor-loading bars (`19/386 - 159MB/s`),
// which would otherwise pollute the step progress indicator.
const stepRe = /(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+s\/it/

export interface RunningGen {
  child: ChildProcess
  stopped: boolean
}

export interface SdCliService {
  generate: (
    binary: string,
    req: GenerationRequest,
    paths: SdCliPaths,
    cb: GenCallbacks
  ) => RunningGen
  stop: (gen: RunningGen) => void
}

export function createSdCliService(): SdCliService {
  function generate(
    binary: string,
    req: GenerationRequest,
    paths: SdCliPaths,
    cb: GenCallbacks
  ): RunningGen {
    const args = buildArgs(req, paths)
    // issues can be diagnosed from the main-process console.
    const child = spawn(binary, args, {
      cwd: dataRoot(),
      env: { ...process.env },
      windowsHide: true
    })
    const gen: RunningGen = { child, stopped: false }

    let stdoutBuf = ''
    let stderrBuf = ''
    let lastStep = -1

    const emitStep = (line: string): void => {
      const m = line.match(stepRe)
      if (m) {
        const step = Number(m[1])
        const total = Number(m[2])
        if (step !== lastStep && (total === req.steps || total > 0)) {
          lastStep = step
          cb.onProgress(step, total)
        }
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8')
      let idx: number
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line) continue
        cb.onLog?.(line)
        emitStep(line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      cb.onError(`Failed to start sd-cli: ${err.message}`)
    })

    child.on('close', (code) => {
      // flush remaining stdout
      if (stdoutBuf.trim()) {
        emitStep(stdoutBuf)
        stdoutBuf = ''
      }
      if (gen.stopped) return // stop is handled by the caller
      if (code === 0) {
        // The requested path first; then the '.avi'-suffixed variant — sd-cli
        // APPENDS .avi when it does not recognize the requested extension
        // (observed as name.mp4.avi with the pre-fix .mp4 requests) — then
        // the newest media file in the session output dir.
        const imagePath = existsSync(paths.output)
          ? paths.output
          : existsSync(paths.output + '.avi')
            ? paths.output + '.avi'
            : findLatestImage(req.sessionId)
        if (imagePath) {
          cb.onDone(imagePath)
          return
        }
        cb.onError('sd-cli finished but no output image was found.')
        return
      }
      const tail = (stderrBuf || stdoutBuf).slice(-2000).trim()
      cb.onError(`sd-cli exited with code ${code}${tail ? `: ${tail}` : ''}`)
    })

    return gen
  }

  function stop(gen: RunningGen): void {
    if (gen.stopped) return
    gen.stopped = true
    const kill = (): void => {
      try {
        gen.child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    try {
      if (process.platform === 'win32') {
        // taskkill /T kills the whole process tree on Windows
        spawn('taskkill', ['/pid', String(gen.child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        gen.child.kill('SIGTERM')
        setTimeout(() => {
          if (!gen.child.killed) kill()
        }, 3000).unref()
      }
    } catch {
      kill()
    }
  }

  return { generate, stop }
}
