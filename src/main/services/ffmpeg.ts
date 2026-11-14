/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { loadFfmpegConfig } from './config'
import { dataRoot } from './data'
import { downloadFile } from './download'
import { createSettingsService } from './settings'

/**
 * ffmpeg bundling + AVI → MP4 conversion (plans/ffmpeg-video-conversion.md).
 *
 * The bundled sd-cli runtime has no ffmpeg muxer, so vid_gen runs emit
 * Motion-JPEG `.avi` files that Chromium cannot play inline. This service:
 * - downloads a per-OS static `ffmpeg` build at launch (init pipeline) into
 *   `data/bin/ffmpeg/` — downloaded once per machine, NOT shipped in the
 *   installer; `ensureFfmpeg()` doubles as the lazy fallback in the
 *   conversion path for users whose launch download failed.
 * - re-encodes generated `.avi` clips to H.264 `.mp4` via `convertToMp4()`
 *   so the chat panel can play them inline.
 */

/** data/bin/ffmpeg — the live ffmpeg install dir (survives app updates). */
export function ffmpegRoot(): string {
  return join(dataRoot(), 'bin', 'ffmpeg')
}

/** Find the ffmpeg binary inside ffmpegRoot(). */
export function findFfmpegBinary(): string | undefined {
  const root = ffmpegRoot()
  if (!existsSync(root)) return undefined
  const candidates = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  for (const name of candidates) {
    const p = join(root, name)
    if (existsSync(p)) return p
  }
  return undefined
}

/** data/tmp/ffmpeg — staged download + extraction dir (wiped each launch). */
function tmpRoot(): string {
  return join(dataRoot(), 'tmp', 'ffmpeg')
}

/**
 * Resolve the platform key for the ffmpeg config: `<platform>_<arch>` first
 * (e.g. `macos_arm64`), then the generic platform key (`macos`). Returns
 * undefined when neither key exists (unknown platform).
 *
 * `process.platform` yields Node names ('win32' | 'darwin' | 'linux') while
 * the config keys use the human names ('windows' | 'macos' | 'linux') —
 * mapped here so the lookup actually matches `configurations/ffmpeg.json`.
 */
function platformKey(): string | undefined {
  const cfg = loadFfmpegConfig()
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
  if (!os) return undefined
  const arch = process.arch // 'x64' | 'arm64' | ...
  const specific = `${os}_${arch}`
  if (cfg.platforms[specific]) return specific
  if (cfg.platforms[os]) return os
  return undefined
}

/**
 * Recursively search `dir` for the ffmpeg binary (the gyan.dev zip nests a
 * versioned folder like `ffmpeg-7.x-essentials_build/bin/ffmpeg.exe`).
 */
function findBinaryIn(dir: string): string | undefined {
  const candidates = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const name of candidates) {
    const p = join(dir, name)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  for (const entry of entries) {
    const sub = join(dir, entry)
    if (!statSync(sub).isDirectory()) continue
    const found = findBinaryIn(sub)
    if (found) return found
  }
  return undefined
}

/** Extract `archive` (zip or tar.xz) into `destDir`. */
async function extractArchive(archive: string, kind: 'zip' | 'tar.xz', destDir: string): Promise<void> {
  if (kind === 'zip') {
    await extractZip(archive, { dir: destDir })
    return
  }
  // tar.xz — Node has no built-in xz support, so shell out to `tar -xf`
  // (macOS ships bsdtar, Linux ships GNU tar; Windows never hits this path
  // because its archive is a zip).
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destDir], {
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar extraction failed (exit ${code}): ${stderr.slice(-500).trim()}`))
    })
  })
}

/**
 * Ensure the ffmpeg binary is installed at `ffmpegRoot()/ffmpeg(.exe)`.
 * Returns the binary path. Downloads + extracts when missing (staged into
 * `data/tmp/ffmpeg/` with `fresh: true`); a module-level in-flight promise
 * dedupes concurrent callers (the init pipeline and a first conversion can
 * race) so the archive is never downloaded twice.
 */
export async function ensureFfmpeg(
  onProgress?: (downloadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const existing = findFfmpegBinary()
  if (existing) return existing

  if (!inflight) {
    inflight = installFfmpeg(onProgress).finally(() => {
      inflight = undefined
    })
  }
  return inflight
}

let inflight: Promise<string> | undefined

async function installFfmpeg(
  onProgress?: (downloadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const key = platformKey()
  if (!key) throw new Error(`No ffmpeg download configured for platform ${process.platform}`)
  const entry = loadFfmpegConfig().platforms[key]
  if (!entry.url) throw new Error(`No ffmpeg build published for ${key} (empty url)`)

  const root = ffmpegRoot()
  const tmp = tmpRoot()
  const archivePath = join(tmp, `ffmpeg-${key}.${entry.archive === 'zip' ? 'zip' : 'tar.xz'}`)

  // 1. Download the static build into the staged tmp dir (fresh: the launch
  //    wipe already cleaned it, but a lazy retry after a failed extraction
  //    must never resume a stale partial).
  mkdirSync(tmp, { recursive: true })
  await downloadFile(entry.url, archivePath, {
    fresh: true,
    onProgress: (downloadedBytes, totalBytes) => onProgress?.(downloadedBytes, totalBytes)
  })

  // 2. Extract into a clean per-attempt dir (a kill mid-extraction cannot
  //    leave a partial tree behind — the next attempt starts over).
  const extractDir = join(tmp, `extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })
  try {
    await extractArchive(archivePath, entry.archive, extractDir)

    // 3. Locate the binary (mirrors nest a versioned folder) and move it to
    //    its live location.
    const found = findBinaryIn(extractDir)
    if (!found) {
      throw new Error(`ffmpeg extracted but binary not found in ${extractDir}`)
    }
    mkdirSync(root, { recursive: true })
    const dest = join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    rmSync(dest, { force: true })
    renameSync(found, dest)

    // 4. POSIX: make it executable. macOS: best-effort quarantine removal so
    //    Gatekeeper does not block the first spawn (ignore failure).
    if (process.platform !== 'win32') {
      chmodSync(dest, 0o755)
      if (process.platform === 'darwin') {
        try {
          spawn('xattr', ['-d', 'com.apple.quarantine', dest], { windowsHide: true })
        } catch {
          /* best-effort */
        }
      }
    }
  } finally {
    // 5. Cleanup: the extraction dir and the staged archive are always
    //    removed, even when extraction failed (the next attempt re-downloads).
    rmSync(extractDir, { recursive: true, force: true })
    rmSync(archivePath, { force: true })
  }

  const binary = findFfmpegBinary()
  if (!binary) throw new Error(`ffmpeg install finished but binary not found in ${root}`)
  return binary
}

/**
 * Re-encode a Motion-JPEG `.avi` clip to H.264 `.mp4` so Chromium can play it
 * inline in a `<video>` element. ALWAYS re-encodes — not a stream-copy remux:
 * Chromium cannot decode MJPEG, so a lossless `-c:v copy` would produce an
 * `.mp4` it can demux but not play. `yuv420p` is required for Chromium decode
 * and `+faststart` moves the moov atom to the front so playback starts
 * immediately. The vid_gen clips are short (seconds), so the encode is
 * near-instant. All three configured mirrors ship libx264.
 *
 * Never deletes the source; the caller decides (keeps the failure path
 * simple and testable). Returns the `.mp4` path.
 */
export async function convertToMp4(input: string): Promise<string> {
  const binary = await ensureFfmpeg()
  const output = input.slice(0, input.length - 4) + '.mp4'

  // Debug aid (Settings → Application → Debug): log the full command line so
  // ffmpeg conversion issues can be diagnosed from the main-process console.
  if (createSettingsService().get().debug) {
    const quoteArg = (a: string): string =>
      /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"')) ? `"${a}"` : a
    console.log(`[ffmpeg] ${[binary, ...[
      '-y', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
    ].map(quoteArg)].join(' ')}`)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        '-y',
        '-i', input,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        output
      ],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail — ffmpeg's progress spam would grow unbounded.
      stderr = (stderr + chunk.toString('utf-8')).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg conversion failed (exit ${code}): ${stderr.slice(-500).trim()}`))
    })
  })
  return output
}
