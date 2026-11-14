/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Standalone sd-cli upscale runner (`sd-cli -M upscale`). Deliberately NOT
// part of SdCliService.generate() — the upscale mode has no step progress and
// no session-shaped argument builder; it is a single one-shot spawn:
//
//   sd-cli -M upscale --upscale-model <modelPath> --init-img <imagePath>
//          --upscale-tile-size <tileSize> --output <outputPath>
//
// (flags verified against the bundled man page, .cached/docs/sd-cli/man.txt:
//  `-M upscale`, `--upscale-model <path>`, `--upscale-tile-size <int>` default
//  128, `--init-img`, `--output`).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataRoot } from './data'
import { createSettingsService } from './settings'

export interface UpscaleParams {
  binary: string
  /** absolute source image */
  imagePath: string
  /** absolute esrgan gguf */
  modelPath: string
  /** absolute destination png */
  outputPath: string
  /** ESRGAN tile size (--upscale-tile-size); default 128 */
  tileSize: number
}

export const DEFAULT_UPSCALE_TILE_SIZE = 128

/**
 * Normalize a renderer-supplied tile size: a finite integer >= 1 passes
 * through; anything else (absent/NaN/0/negative) falls back to the app-level
 * default of 128 (matching the sd-cli default, man.txt:206).
 */
export function normalizeTileSize(tileSize: unknown): number {
  if (typeof tileSize === 'number' && Number.isFinite(tileSize) && tileSize >= 1) {
    return Math.floor(tileSize)
  }
  return DEFAULT_UPSCALE_TILE_SIZE
}

/**
 * Output naming: `<orig-basename-minus-ext>-upscaled.png` in the source
 * image's directory, de-duplicated with a numeric suffix when the path
 * already exists (`-upscaled-2.png`, …). The source dir is the session
 * output dir (data/output/<sessionId>/), so the result lands beside the
 * original and the appended assistant message carries a stable path.
 */
export function upscaleOutputPath(imagePath: string): string {
  const dir = dirname(imagePath)
  const base = basename(imagePath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  let candidate = join(dir, `${stem}-upscaled.png`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-upscaled-${n}.png`)
    n++
  }
  return candidate
}

// Single-flight guard: one upscale at a time (a second concurrent
// `upscale:start` rejects immediately). No cancel channel in v1 — the busy
// overlay has no cancel control per spec.
let inFlight: Promise<void> | null = null

export function isUpscaling(): boolean {
  return inFlight !== null
}

/**
 * Run one sd-cli upscale. Resolves when the process exits 0 AND the output
 * file exists; rejects with the generate()-style error shape otherwise.
 */
export function runUpscale(p: UpscaleParams): Promise<void> {
  if (inFlight) return Promise.reject(new Error('An upscale is already running'))
  inFlight = doRun(p).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doRun(p: UpscaleParams): Promise<void> {
  const args = [
    '-M',
    'upscale',
    '--upscale-model',
    p.modelPath,
    '--init-img',
    p.imagePath,
    '--upscale-tile-size',
    String(p.tileSize),
    '--output',
    p.outputPath
  ]

  // Debug aid (Settings → Application → Debug): log the full command line so
  // upscale issues can be diagnosed from the main-process console.
  if (createSettingsService().get().debug) {
    const quoteArg = (a: string): string =>
      /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"')) ? `"${a}"` : a
    console.log(`[sd-cli] ${[p.binary, ...args.map(quoteArg)].join(' ')}`)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(p.binary, args, {
      cwd: dataRoot(),
      env: { ...process.env },
      windowsHide: true
    })
    let stderrBuf = ''
    let stdoutBuf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      reject(new Error(`Failed to start sd-cli: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        if (existsSync(p.outputPath)) {
          resolve()
          return
        }
        reject(new Error('sd-cli finished but no output image was found.'))
        return
      }
      const tail = (stderrBuf || stdoutBuf).slice(-2000).trim()
      reject(new Error(`sd-cli exited with code ${code}${tail ? `: ${tail}` : ''}`))
    })
  })
}
