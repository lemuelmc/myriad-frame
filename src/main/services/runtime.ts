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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import type {
  DownloadProgress,
  RuntimeConfig,
  RuntimeKey,
  RuntimeVersionInfo
} from '@shared/types'
import { loadRuntimeConfig } from './config'
import { downloadFile, headSize } from './download'

import { dataRoot } from './data'

/** data/ root (writable user-data directory). */
export function getDataRoot(): string {
  return dataRoot()
}

function runtimeRoot(): string {
  return join(getDataRoot(), 'runtime')
}

function versionDir(version: string): string {
  return join(runtimeRoot(), version)
}

/** Find the sd-cli binary inside an extracted version dir. */
export function findSdCliBinary(version: string): string | undefined {
  const dir = versionDir(version)
  if (!existsSync(dir)) return undefined
  const candidates = process.platform === 'win32' ? ['sd-cli.exe'] : ['sd-cli']
  for (const name of candidates) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  // search one level deep (some releases nest the binary)
  try {
    for (const entry of readdirSync(dir)) {
      const sub = join(dir, entry)
      if (!statSync(sub).isDirectory()) continue
      for (const name of candidates) {
        const p = join(sub, name)
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

export interface RuntimeService {
  versions: () => RuntimeVersionInfo[]
  download: (version: string, key: RuntimeKey, onProgress: (p: DownloadProgress) => void) => Promise<void>
  binaryFor: (version: string) => string | undefined
}

export function createRuntimeService(): RuntimeService {
  const downloads = new Map<string, DownloadProgress>()

  function versions(): RuntimeVersionInfo[] {
    const cfg = loadRuntimeConfig()
    return Object.keys(cfg)
      .sort((a, b) => Number(b) - Number(a))
      .map((version) => {
        const binary = findSdCliBinary(version)
        const dl = downloads.get(version)
        return {
          version,
          installed: binary !== undefined,
          downloading: dl !== undefined,
          downloadedBytes: dl?.downloadedBytes ?? 0,
          totalBytes: dl?.totalBytes ?? 0,
          binary
        }
      })
  }

  async function download(
    version: string,
    key: RuntimeKey,
    onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    const cfg = loadRuntimeConfig()
    const urls = requiredUrls(cfg, version, key)
    if (urls.length === 0) throw new Error(`No runtime url for version ${version} / ${key}`)
    if (downloads.has(version)) throw new Error(`Download for ${version} already in progress`)

    const destDir = versionDir(version)
    const downloadsRoot = join(getDataRoot(), 'runtime')

    // Download every archive as one continuous stream, then extract them all at
    // the end. This keeps the progress as a single Downloading -> 100% ->
    // Extracting sequence instead of repeating a cycle per archive (some
    // runtimes, e.g. windows_cuda12, ship a main archive plus supporting
    // libraries as separate downloads).
    const perUrlSize = new Map<string, number>()
    let grandTotal = 0
    for (const { key: dlKey, url } of urls) {
      const size = await headSize(url)
      perUrlSize.set(dlKey, size)
      grandTotal += size
    }

    downloads.set(version, { downloadedBytes: 0, totalBytes: grandTotal, phase: 'downloading' })
    try {
      // 1. Download all archives, reporting cumulative progress toward grandTotal.
      for (const { key: dlKey, url } of urls) {
        const zipPath = join(downloadsRoot, `sd-${version}-${dlKey}.zip`)
        const offset = grandTotal - (perUrlSize.get(dlKey) ?? 0)
        await downloadFile(url, zipPath, {
          onProgress: (downloadedBytes, totalBytes) => {
            const done = offset + downloadedBytes
            downloads.set(version, { downloadedBytes: done, totalBytes: grandTotal, phase: 'downloading' })
            onProgress({ downloadedBytes: done, totalBytes: grandTotal, phase: 'downloading' })
          }
        })
      }

      // 2. Extract everything, then report the 100% extract phase once.
      mkdirSync(destDir, { recursive: true })
      const done = grandTotal
      downloads.set(version, { downloadedBytes: done, totalBytes: grandTotal, phase: 'extracting' })
      onProgress({ downloadedBytes: done, totalBytes: grandTotal, phase: 'extracting' })
      for (const { key: dlKey } of urls) {
        const zipPath = join(downloadsRoot, `sd-${version}-${dlKey}.zip`)
        await extractZip(zipPath, { dir: destDir })
        rmSync(zipPath, { force: true })
      }

      if (!findSdCliBinary(version)) {
        throw new Error(`Runtime extracted but sd-cli binary not found in ${destDir}`)
      }
    } finally {
      downloads.delete(version)
    }
  }

  function binaryFor(version: string): string | undefined {
    return findSdCliBinary(version)
  }

  /**
   * Extra runtime keys that must be downloaded alongside a selected runtime
   * key. Some runtimes ship their supporting artifacts (e.g. the CUDA runtime
   * libraries) as separate downloads.
   */
  const extraKeys: Partial<Record<RuntimeKey, RuntimeKey[]>> = {
    windows_cuda12: ['windows_cuda12_libraries']
  }

  function requiredUrls(
    cfg: RuntimeConfig,
    version: string,
    key: RuntimeKey
  ): { key: RuntimeKey; url: string }[] {
    const targets = [key, ...(extraKeys[key] ?? [])]
    return targets
      .filter((k) => cfg[version]?.[k])
      .map((k) => ({ key: k, url: cfg[version][k] as string }))
  }

  return { versions, download, binaryFor }
}
