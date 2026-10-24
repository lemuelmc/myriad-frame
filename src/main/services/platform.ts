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

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { PlatformInfo, RuntimeKey } from '@shared/types'

const pExecFile = promisify(execFile)

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return pExecFile(cmd, args, { timeout: timeoutMs, windowsHide: true }).then(
    (r) => r.stdout
  )
}

/** Windows: check NVIDIA via nvidia-smi, then WMI video controllers for AMD. */
async function detectWindowsGpu(): Promise<{ gpu: PlatformInfo['gpu']; detail?: string }> {
  // NVIDIA
  try {
    const out = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first) return { gpu: 'nvidia', detail: first }
  } catch {
    // nvidia-smi not available
  }
  // WMI video controllers
  try {
    const out = await run(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
      15000
    )
    const names = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const nvidia = names.find((n) => /nvidia|geforce|quadro|rtx|gtx/i.test(n))
    if (nvidia) return { gpu: 'nvidia', detail: nvidia }
    const amd = names.find((n) => /amd|radeon|rx \d/i.test(n))
    if (amd) return { gpu: 'amd', detail: amd }
    if (names.length > 0) return { gpu: 'none', detail: names.join(', ') }
    return { gpu: 'unknown' }
  } catch {
    return { gpu: 'unknown' }
  }
}

/** Linux: NVIDIA via /proc/driver/nvidia, otherwise lspci for any GPU. */
async function detectLinuxGpu(): Promise<{ gpu: PlatformInfo['gpu']; detail?: string }> {
  if (existsSync('/proc/driver/nvidia/version')) {
    let detail = 'NVIDIA'
    try {
      const { readFileSync } = await import('node:fs')
      detail = readFileSync('/proc/driver/nvidia/version', 'utf-8').trim().split('\n')[0]
    } catch {
      /* ignore */
    }
    return { gpu: 'nvidia', detail }
  }
  try {
    const out = await run('lspci', [], 15000)
    const gpuLine = out
      .split(/\r?\n/)
      .find((l) => /vga|3d controller|display/i.test(l))
    if (gpuLine) {
      if (/nvidia|geforce|quadro/i.test(gpuLine)) return { gpu: 'nvidia', detail: gpuLine.trim() }
      if (/amd|radeon/i.test(gpuLine)) return { gpu: 'amd', detail: gpuLine.trim() }
      return { gpu: 'unknown', detail: gpuLine.trim() }
    }
    return { gpu: 'none' }
  } catch {
    // lspci not available; try /sys
    try {
      const { readdirSync } = await import('node:fs')
      const pci = readdirSync('/sys/bus/pci/devices')
      for (const d of pci) {
        try {
          const { readFileSync } = await import('node:fs')
          const cls = readFileSync(`/sys/bus/pci/devices/${d}/class`, 'utf-8').trim()
          if (cls.startsWith('0x03')) return { gpu: 'unknown', detail: d }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return { gpu: 'none' }
  }
}

export function runtimeKeyFor(os: PlatformInfo['os'], gpu: PlatformInfo['gpu']): RuntimeKey {
  switch (os) {
    case 'win32':
      if (gpu === 'nvidia') return 'windows_cuda12'
      if (gpu === 'amd') return 'windows_vulkan'
      return 'windows_cpu'
    case 'darwin':
      return 'macos_silicon'
    case 'linux':
      if (gpu === 'nvidia' || gpu === 'amd') return 'linux_vulkan'
      return 'linux_cpu'
  }
}

export async function detectPlatform(): Promise<PlatformInfo> {
  const os: PlatformInfo['os'] =
    process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
      ? process.platform
      : 'linux'
  let gpu: PlatformInfo['gpu'] = 'unknown'
  let detail: string | undefined

  if (os === 'win32') {
    const r = await detectWindowsGpu()
    gpu = r.gpu
    detail = r.detail
  } else if (os === 'darwin') {
    gpu = 'unknown' // treated as silicon
    detail = 'Apple Silicon'
  } else if (os === 'linux') {
    const r = await detectLinuxGpu()
    gpu = r.gpu
    detail = r.detail
  }

  const runtimeKey = runtimeKeyFor(os, gpu)
  return { os, gpu, gpuDetail: detail, runtimeKey }
}
