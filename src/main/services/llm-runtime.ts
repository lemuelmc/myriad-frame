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
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { loadLlmRuntimeConfig } from './config'
import { dataRoot } from './data'
import { downloadFile } from './download'

/**
 * LLM runtime service (plans/llm-prompt-enhancer.md §2): downloads + extracts
 * the llama.cpp (`llama-cli`) build for the detected platform into
 * `data/bin/llm/<version>/`. Mirrors the ffmpeg.ts pattern (downloaded once per
 * machine, NOT shipped in the installer; a module-level in-flight promise
 * dedupes concurrent callers so the init pipeline and a lazy enhance retry
 * never double-download) with the runtime.ts multi-archive shape (a CUDA build
 * ships a separate `*_lib` cudart archive that must land in the SAME directory
 * as the main archive — DLL dependencies).
 */

/** data/bin/llm — the live llama.cpp install root (survives app updates). */
export function llmRoot(): string {
  return join(dataRoot(), 'bin', 'llm')
}

/** data/bin/llm/<version> — the per-version install dir. */
function llmVersionDir(version: string): string {
  return join(llmRoot(), version)
}

/** data/tmp/llm — staged download dir (wiped each launch). */
function tmpRoot(): string {
  return join(dataRoot(), 'tmp', 'llm')
}

const binaryName = process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli'

/**
 * The newest release key from llm_runtime.json — max numeric suffix after
 * stripping the leading `b` (e.g. 'b12207' → 12207), lexicographic fallback
 * for keys that do not fit that shape. Undefined when the config carries no
 * releases (or the file is missing — loadLlmRuntimeConfig throws, which the
 * caller treats as "no runtime available"). Superseded version dirs persist
 * on disk (the data/runtime/<version>/ convention — no pruning for v1).
 */
export function latestLlmVersion(): string | undefined {
  let releases: Record<string, Record<string, string>>
  try {
    releases = loadLlmRuntimeConfig().releases ?? {}
  } catch {
    return undefined
  }
  const keys = Object.keys(releases)
  if (keys.length === 0) return undefined
  const rank = (k: string): number | undefined => {
    const m = k.match(/^b(\d+)$/)
    return m ? Number(m[1]) : undefined
  }
  const numeric = keys.filter((k) => rank(k) !== undefined)
  if (numeric.length > 0) {
    return numeric.reduce((a, b) => ((rank(b) as number) > (rank(a) as number) ? b : a))
  }
  return keys.reduce((a, b) => (b > a ? b : a))
}

/**
 * Find the llama-cli binary inside a version dir — root plus a bounded
 * recursive search (release zips sometimes nest a versioned folder; the
 * findSdCliBinary pattern). Without `version`, the latest release key is used.
 */
export function findLlamaCliBinary(version?: string): string | undefined {
  const v = version ?? latestLlmVersion()
  if (!v) return undefined
  const dir = llmVersionDir(v)
  if (!existsSync(dir)) return undefined
  return findBinaryIn(dir, 0)
}

function findBinaryIn(dir: string, depth: number): string | undefined {
  const p = join(dir, binaryName)
  if (existsSync(p) && statSync(p).isFile()) return p
  if (depth >= 3) return undefined
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const name of entries) {
    const sub = join(dir, name)
    if (!statSync(sub).isDirectory()) continue
    const found = findBinaryIn(sub, depth + 1)
    if (found) return found
  }
  return undefined
}

/** The archive strategy for a URL — zip on Windows, tar.gz elsewhere. */
function archiveKind(url: string): 'zip' | 'tar.gz' {
  return url.toLowerCase().endsWith('.zip') ? 'zip' : 'tar.gz'
}

/** Extract `archive` (zip or tar.gz) into `destDir`. */
async function extractArchive(archive: string, kind: 'zip' | 'tar.gz', destDir: string): Promise<void> {
  if (kind === 'zip') {
    await extractZip(archive, { dir: destDir })
    return
  }
  // tar.gz — bsdtar/GNU tar autodetect gzip (`tar -xf`); macOS ships bsdtar,
  // Linux ships GNU tar. Windows never hits this path (its archives are zip).
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

export interface LlmRuntimeProgress {
  downloadedBytes: number
  totalBytes: number
  phase?: 'downloading' | 'extracting'
}

let inflight: Promise<string> | undefined

/**
 * Ensure the llama-cli binary is installed for the given platform key.
 * Returns the binary path. Binary found → return immediately (one cheap
 * existsSync on every launch). Otherwise downloads ALL archives for the key
 * (+ the `*_lib` cudart companion) as ONE cumulative progress stream into the
 * staged tmp dir (`fresh: true` — a lazy retry after a failed extraction must
 * never resume a stale partial), wipes + extracts into the version dir, then
 * deletes the archives and verifies the binary. A module-level in-flight
 * promise dedupes concurrent callers (the init pipeline and a lazy enhance
 * retry can race) so the archives are never downloaded twice. Throws on any
 * failure — the caller decides fatality (the init pipeline is non-fatal; the
 * enhance path surfaces the error as a toast).
 */
export async function ensureLlmRuntime(
  platformKey: string | undefined,
  onProgress?: (p: LlmRuntimeProgress) => void
): Promise<string> {
  const existing = findLlamaCliBinary()
  if (existing) return existing
  if (!inflight) {
    inflight = installLlmRuntime(platformKey, onProgress).finally(() => {
      inflight = undefined
    })
  }
  return inflight
}

async function installLlmRuntime(
  platformKey: string | undefined,
  onProgress?: (p: LlmRuntimeProgress) => void
): Promise<string> {
  if (!platformKey) throw new Error('No LLM runtime for this platform')
  const cfg = loadLlmRuntimeConfig()
  const version = latestLlmVersion()
  if (!version) throw new Error('No LLM runtime releases configured')
  const release = cfg.releases[version] ?? {}
  // The main archive + the `*_lib` cudart companion (DLL dependencies that
  // must land in the SAME directory — the runtime.ts extraKeys pattern).
  const targets: { key: string; url: string }[] = [platformKey, `${platformKey}_lib`]
    .map((key) => ({ key, url: release[key] }))
    .filter((t): t is { key: string; url: string } => typeof t.url === 'string' && t.url !== '')
  if (targets.length === 0) throw new Error(`No LLM runtime build published for ${platformKey}`)

  const tmp = tmpRoot()
  const destDir = llmVersionDir(version)

  // 1. Download all archives into the staged tmp dir (fresh: the launch wipe
  //    already cleaned it, but a lazy retry must never resume a stale partial).
  mkdirSync(tmp, { recursive: true })
  const sizes: number[] = []
  for (const t of targets) sizes.push(await headSizeOf(t.url))
  const grandTotal = sizes.reduce((a, b) => a + b, 0) || 0
  let done = 0
  const archives: { path: string; kind: 'zip' | 'tar.gz' }[] = []
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      const kind = archiveKind(t.url)
      const archivePath = join(tmp, `llama-${version}-${t.key}.${kind === 'zip' ? 'zip' : 'tar.gz'}`)
      await downloadFile(t.url, archivePath, {
        fresh: true,
        onProgress: (downloadedBytes, totalBytes) => {
          // Cumulative progress across the (up to two) archives: the bytes of
          // the finished archives plus the current one's position within its
          // own reported total (the per-archive total may differ from the
          // pre-computed HEAD size, so scale by the reported total when it is
          // known — otherwise fall back to the HEAD estimate proportionally).
          const slot = sizes[i] || totalBytes || 0
          const scaled = totalBytes > 0 ? Math.round((slot * downloadedBytes) / totalBytes) : downloadedBytes
          onProgress?.({ downloadedBytes: done + scaled, totalBytes: grandTotal, phase: 'downloading' })
        }
      })
      done += sizes[i] || 0
      archives.push({ path: archivePath, kind })
    }

    // 2. Wipe + extract into a clean version dir (a kill mid-extraction cannot
    //    leave a partial tree behind — the next attempt starts over). All
    //    archives land in the SAME directory (the cudart DLLs sit next to the
    //    binaries they support). Extraction progress is reported as the final
    //    100% with the `extracting` phase (mirrors the runtime service shape).
    onProgress?.({ downloadedBytes: grandTotal, totalBytes: grandTotal, phase: 'extracting' })
    mkdirSync(destDir, { recursive: true })
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    for (const a of archives) {
      await extractArchive(a.path, a.kind, destDir)
    }

    // 3. Verify the binary (mirrors nest a versioned folder — the bounded
    //    recursive search covers that; no move needed, the dir IS the install).
    const binary = findBinaryIn(destDir, 0)
    if (!binary) throw new Error(`LLM runtime extracted but ${binaryName} not found in ${destDir}`)

    // 4. POSIX: make it executable. macOS: best-effort quarantine removal so
    //    Gatekeeper does not block the first spawn (ignore failure). The whole
    //    extracted tree is chmod'd — llama-cli shells may carry helper dylibs
    //    that also need the exec bit preserved (archives usually keep it; this
    //    is defensive for zip extracts that drop permissions).
    if (process.platform !== 'win32') {
      chmodTree(destDir)
      if (process.platform === 'darwin') {
        try {
          spawn('xattr', ['-d', 'com.apple.quarantine', binary], { windowsHide: true })
        } catch {
          /* best-effort */
        }
      }
    }
    return binary
  } finally {
    // 5. Cleanup: the staged archives are always removed, even when extraction
    //    failed (the next attempt re-downloads; the version dir is wiped first
    //    on every attempt so no partial tree survives either way).
    for (const a of archives) rmSync(a.path, { force: true })
  }
}

/** HEAD the archive URL for its Content-Length (best-effort; 0 on failure). */
async function headSizeOf(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    const len = res.headers.get('content-length')
    return len ? Number(len) || 0 : 0
  } catch {
    return 0
  }
}

/** chmod 0o755 every file in the tree (best-effort, failures ignored). */
function chmodTree(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory()) chmodTree(p)
      else chmodSync(p, 0o755)
    } catch {
      /* best-effort */
    }
  }
}

/** Shape returned by `llmStatus()` — the Settings row + Enhance gating data. */
export interface LlmRuntimeStatus {
  version?: string
  installed: boolean
  platformKey?: string
  binary?: string
}

/**
 * The LLM runtime status for a platform key: the latest release key, whether
 * the llama-cli binary is installed, and the resolved binary path when it is.
 * `platformKey` undefined → `installed: false` with no version (the platform
 * has no LLM runtime — the Enhance feature reports that).
 */
export function llmStatus(platformKey?: string): LlmRuntimeStatus {
  const version = latestLlmVersion()
  const binary = findLlamaCliBinary(version)
  return {
    version: platformKey ? version : undefined,
    installed: !!binary,
    platformKey,
    binary
  }
}
