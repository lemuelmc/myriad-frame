/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GenerationRequest, PerformanceSettings } from '@shared/types'

export interface SdCliPaths {
  model: string
  /** how `model` is passed: 'all_in_one' → full checkpoint via `--model`
   *  (conditioners/VAE inside the file); 'standalone' (default) →
   *  `--diffusion-model` (weights only) */
  modelBehavior?: 'all_in_one' | 'standalone'
  vae?: string
  encoder?: string
  /** encoder bundle (SD3.5-style): each file + the CLI flag it is passed under */
  encoders?: { path: string; useAs: string }[]
  vision?: string
  /** img2img init image — emitted as `--init-img` when set; the referenced
   *  image reinterpreted as the input image (see gen:start) */
  initImage?: string
  references: string[]
  output: string
}

/**
 * Build the sd-cli argument list.
 * Flag names verified against `sd-cli --help` (commit a77d362) and the
 * official model docs (docs/resolution-qwen-image.md, docs/resolution-zimage.md):
 * the diffusion weights go to `--diffusion-model` (or to `--model` when the
 * diffusion type is `all_in_one` — a full checkpoint that already contains
 * conditioners and VAE, so the standalone `--vae` override is skipped), the
 * text encoder to
 * `--llm` (single-file) or to one `--<use_as>` flag per bundle file
 * (SD3.5-style multi-encoder: `--clip_g`, `--clip_l`, `--t5xxl`), the vision
 * (mmproj) model to `--llm_vision` (this build has no `--mmproj` flag),
 * an optional init image to `--init-img` (img2img input) together with
 * `--strength` (the pair is emitted only when the init image is set), the
 * reference images to repeatable `--ref-image` entries (before `--output`),
 * and the result image to `--output`.
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

  // 'all_in_one' types ship a full checkpoint (conditioners + VAE inside) —
  // passed as `--model`; standalone types (default) via `--diffusion-model`.
  const args: string[] = [
    p.modelBehavior === 'all_in_one' ? '--model' : '--diffusion-model',
    p.model,
    '--prompt', quotePrompt(req.prompt),
    '--steps', String(req.steps),
    '--cfg-scale', String(req.cfg),
    '--sampling-method', req.sampler,
    '--width', String(req.resolution.width),
    '--height', String(req.resolution.height),
    '--seed', String(randomSeed())
  ]
  // Sigma scheduler — emitted only when the resolved value is a concrete,
  // non-empty string (main resolves the 'model-specific' sentinel to undefined
  // before spawn, so buildArgs() never sees it; null/undefined/'' ⇒ skip).
  if (req.scheduler && req.scheduler.trim()) args.push('--scheduler', req.scheduler.trim())
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
  if (p.initImage) {
    args.push('--init-img', p.initImage)
    // denoise strength — only meaningful with an init image, so the pair is
    // emitted together and txt2img command lines stay free of `--strength`
    args.push('--strength', String(req.strength))
  }
  for (const ref of p.references) args.push('--ref-image', ref)

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

  if (perf.flashAttention) {
    args.push('--flash-attn', perf.flashAttention)
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

export function newOutputPath(sessionId: string, messageId: string): string {
  const dir = join(outputDir(), sessionId)
  mkdirSync(dir, { recursive: true })
  const name = `${messageId}-${Date.now()}.png`
  return join(dir, name)
}

/**
 * Find the most recently modified image file in the session output dir
 * (fallback when the expected output path was not written).
 */
function findLatestImage(sessionId: string): string | undefined {
  const dir = join(outputDir(), sessionId)
  if (!existsSync(dir)) return undefined
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp'])
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
    // Debug aid: log the complete command line (binary + args) so generation
    // issues can be diagnosed from the main-process console. Args containing
    // whitespace are wrapped in double quotes — except ones that already
    // start and end with a quote (the prompt is pre-wrapped by buildArgs()),
    // so the logged line can be pasted back into a shell as-is.
    const quoteArg = (a: string): string =>
      /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"')) ? `"${a}"` : a
    // Debug aid: log the complete command line (binary + args) so generation
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
        const imagePath = existsSync(paths.output) ? paths.output : findLatestImage(req.sessionId)
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
