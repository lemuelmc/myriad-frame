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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AllConfigs, HubConfig, ResolutionConfig, RuntimeConfig, SamplingConfig } from '@shared/types'

/**
 * Root that contains the `configurations/` folder.
 * Dev: project root. Packaged: resources/ (via electron-builder extraResources).
 */
export function getAppRoot(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'configurations'), join(process.resourcesPath)]
    : [join(app.getAppPath(), 'configurations'), app.getAppPath()]
  for (const c of candidates) {
    if (existsSync(join(c, 'hub.json'))) return c
  }
  return candidates[0]
}

function readJson<T>(file: string): T {
  const raw = readFileSync(file, 'utf-8')
  return JSON.parse(raw) as T
}

export function loadHubConfig(): HubConfig {
  return readJson<HubConfig>(join(getAppRoot(), 'hub.json'))
}

export function loadSamplingConfig(): SamplingConfig {
  return readJson<SamplingConfig>(join(getAppRoot(), 'sampling.json'))
}

export function loadResolutionConfig(): ResolutionConfig {
  return readJson<ResolutionConfig>(join(getAppRoot(), 'resolution.json'))
}

export function loadRuntimeConfig(): RuntimeConfig {
  return readJson<RuntimeConfig>(join(getAppRoot(), 'runtime.json'))
}

export function loadAllConfigs(): AllConfigs {
  return {
    hub: loadHubConfig(),
    sampling: loadSamplingConfig(),
    resolution: loadResolutionConfig(),
    runtime: loadRuntimeConfig()
  }
}
