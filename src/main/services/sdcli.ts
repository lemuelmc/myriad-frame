/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

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
  vae?: string
  encoder?: string
  vision?: string
  references: string[]
  output: string
}

/**
 * Build the sd-cli argument list.
 * Flag names verified against `sd-cli --help` (commit a77d362) and the
 * official model docs (docs/resolution-qwen-image.md, docs/resolution-zimage.md):
 * standalone diffusion weights go to `--diffusion-model`, the text encoder to
 * `--llm`, the vision (mmproj) model to `--llm_vision` (this build has no
 * `--mmproj` flag), reference images to repeatable `--ref-image` entries
 * (before `--output`), and the result image to `--output`.
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

  const args: string[] = [
    '--diffusion-model', p.model,
    '--prompt', quotePrompt(req.prompt),
    '--steps', String(req.steps),
    '--cfg-scale', String(req.cfg),
    '--sampling-method', req.sampler,
    '--width', String(req.resolution.width),
    '--height', String(req.resolution.height),
    '--seed', String(randomSeed())
  ]
  if (p.vae) args.push('--vae', p.vae)
  if (p.encoder) args.push('--llm', p.encoder)
  // Vision (mmproj) model — the projection model that bridges the diffusion
  // transformer to the text encoder. Only emitted when the diffusion_type
  // declares a `vision` dependency in hub.json. Note: this sd-cli build
  // exposes it as `--llm_vision` (there is no `--mmproj` flag).
  if (p.vision) args.push('--llm_vision', p.vision)
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
