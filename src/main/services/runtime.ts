/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

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
import {
  getRuntimeState,
  runtimeInflight,
  trackRuntimeDownload
} from './downloads'

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
  function versions(): RuntimeVersionInfo[] {
    const cfg = loadRuntimeConfig()
    return Object.keys(cfg)
      .sort((a, b) => Number(b) - Number(a))
      .map((version) => {
        const binary = findSdCliBinary(version)
        const state = getRuntimeState(version)
        return {
          version,
          installed: binary !== undefined,
          downloading: state.downloading,
          downloadedBytes: state.progress.downloadedBytes,
          totalBytes: state.progress.totalBytes,
          binary
        }
      })
  }

  /**
   * Download and extract a runtime version. Each archive is staged in
   * data/tmp/runtime/ (deleting any partial first), downloaded fully with an
   * abort signal from the manager, extracted to data/runtime/<version>/, then
   * the zips are deleted. In-flight state lives in the manager so a second call
   * for an in-flight version joins the same Promise instead of starting a
   * duplicate download.
   *
   * The `onProgress` parameter is retained so the init pipeline can drive
   * init:status; the manager invokes it *and* broadcasts runtime:progress.
   */
  async function download(
    version: string,
    key: RuntimeKey,
    onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    const cfg = loadRuntimeConfig()
    const urls = requiredUrls(cfg, version, key)
    if (urls.length === 0) throw new Error(`No runtime url for version ${version} / ${key}`)

    // Join an in-flight download of the same version (or start a new one).
    const existing = runtimeInflight(version)
    if (existing) return existing

    const handle = trackRuntimeDownload(version, (p) =>
      onProgress({ downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes, phase: p.phase } as DownloadProgress)
    )

    const work = async (): Promise<void> => {
      const destDir = versionDir(version)
      const downloadsRoot = join(getDataRoot(), 'tmp', 'runtime')

      // Download every archive as one continuous stream, then extract them all
      // at the end. This keeps the progress as a single Downloading -> 100% ->
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

      // 1. Download all archives, reporting cumulative progress toward grandTotal.
      for (const { key: dlKey, url } of urls) {
        const zipPath = join(downloadsRoot, `sd-${version}-${dlKey}.zip`)
        const offset = grandTotal - (perUrlSize.get(dlKey) ?? 0)
        const signal = handle.signalFor(url)
        await downloadFile(url, zipPath, {
          fresh: true,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            const done = offset + downloadedBytes
            handle.report({ downloadedBytes: done, totalBytes: grandTotal, phase: 'downloading' })
          }
        })
      }

      // 2. Extract everything, then report the 100% extract phase once. The
      // version dir is wiped first so a kill mid-extraction cannot leave a
      // partial tree behind.
      mkdirSync(destDir, { recursive: true })
      rmSync(destDir, { recursive: true, force: true })
      mkdirSync(destDir, { recursive: true })
      const done = grandTotal
      handle.report({ downloadedBytes: done, totalBytes: grandTotal, phase: 'extracting' })
      onProgress({ downloadedBytes: done, totalBytes: grandTotal, phase: 'extracting' })
      for (const { key: dlKey } of urls) {
        const zipPath = join(downloadsRoot, `sd-${version}-${dlKey}.zip`)
        await extractZip(zipPath, { dir: destDir })
        rmSync(zipPath, { force: true })
      }

      if (!findSdCliBinary(version)) {
        throw new Error(`Runtime extracted but sd-cli binary not found in ${destDir}`)
      }
    }

    try {
      await work()
      handle.finish(true)
    } catch (err) {
      handle.finish(false)
      throw err
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
