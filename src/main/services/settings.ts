/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { dataRoot } from './data'

function settingsPath(): string {
  return join(dataRoot(), 'settings.json')
}

export interface SettingsService {
  get: () => Settings
  save: (patch: Partial<Settings>) => Settings
}

export function createSettingsService(): SettingsService {
  function get(): Settings {
    const p = settingsPath()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as Settings
    } catch {
      return {}
    }
  }

  function save(patch: Partial<Settings>): Settings {
    const current = get()
    const next: Settings = { ...current, ...patch }
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2))
    return next
  }

  return { get, save }
}
