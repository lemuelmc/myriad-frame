/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

// Pure-math + snapping helpers for the unified resolution selector dialog
// (plans/unified-resolution-selector.md). Kept in a standalone module so the
// math is reviewable in isolation — the project has no test runner, but a
// separate unit makes one trivial to add later.

import type { ResolutionEntry } from '@shared/types'

/** The chips the dialog offers, in display order. 'presets' switches the
 *  dialog to dropdown-driven picks straight from the model's configured
 *  preset list (configurations/resolution.json); 'custom' frees W/H. */
export const RATIO_CHIPS = ['1:1', '4:3', '3:2', '16:9', 'presets', 'custom'] as const
export type RatioChip = (typeof RATIO_CHIPS)[number]

/** Megapixel slider bounds (user-confirmed): 0.25–4.0 MP, step 0.05, center 1.0. */
export const MP_MIN = 0.25
export const MP_MAX = 4.0
export const MP_STEP = 0.05
export const MP_DEFAULT = 1.0

/** "Divisible by" slider bounds: 0 (no snap) – 64, step 1. Default 8. */
export const DIV_MIN = 0
export const DIV_MAX = 64
export const DIV_DEFAULT = 8

/** W/H input clamps — positive integers only (tiny sizes break VAE tiling,
 *  huge ones exhaust VRAM; sd-cli itself has no hard limit). */
export const DIM_MIN = 64
export const DIM_MAX = 4096

/** Parse a ratio chip label like "4:3" into its aspect number (4/3);
 *  'custom' and 'presets' carry no fixed ratio → null. */
export function ratioOf(chip: RatioChip): number | null {
  if (chip === 'custom' || chip === 'presets') return null
  const parts = chip.split(':')
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return w / h
}

/** Snap a value to the nearest multiple of n; n ≤ 1 → plain rounding (no snap). */
export function snapTo(value: number, n: number): number {
  const v = Math.round(value)
  if (!Number.isFinite(n) || n <= 1) return v
  return Math.round(v / n) * n
}

/** Clamp a raw input into the valid integer dimension range. */
export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return DIM_MIN
  return Math.min(DIM_MAX, Math.max(DIM_MIN, Math.round(value)))
}

/**
 * Pure-math dimensions for an arbitrary ratio at a given megapixel value,
 * snapped by `div`: w = √(mp·10⁶·ratio), h = w/ratio.
 */
export function dimensionsForRatio(
  ratio: number,
  mp: number,
  div: number
): { width: number; height: number } {
  const wRaw = Math.sqrt(mp * 1_000_000 * ratio)
  const hRaw = wRaw / ratio
  return { width: snapTo(wRaw, div), height: snapTo(hRaw, div) }
}

/**
 * Pure-math dimensions for a ratio chip at a given megapixel value, snapped
 * by `div`. Returns null for 'custom' / 'presets' (no fixed ratio).
 */
export function dimensionsFor(
  chip: RatioChip,
  mp: number,
  div: number
): { width: number; height: number } | null {
  const ratio = ratioOf(chip)
  if (ratio === null) return null
  return dimensionsForRatio(ratio, mp, div)
}

/**
 * Find the preset entry whose width/height ratio exactly matches the chip's
 * ratio (never match by name — names vary per model: "4:3 Landscape",
 * "4:3 Standard (W)", "Photo (W)", "16:9 (1.0mp)"…). `orientation` picks the
 * wider (w > h) or taller (w < h) variant; square entries match either.
 * Returns null when the model's list has no entry at that ratio.
 */
export function presetForChip(
  chip: RatioChip,
  orientation: 'landscape' | 'portrait',
  presets: ResolutionEntry[]
): ResolutionEntry | null {
  const ratio = ratioOf(chip)
  if (ratio === null) return null
  const matches = presets.filter((p) => {
    if (p.width <= 0 || p.height <= 0) return false
    return Math.abs(p.width / p.height - ratio) < 1e-6
  })
  if (matches.length === 0) return null
  const wantWide = orientation === 'landscape'
  const shaped = matches.filter((p) => p.width === p.height || (p.width > p.height) === wantWide)
  return shaped[0] ?? matches[0]
}

/**
 * Reverse-map a current entry to its dialog state: a ratio-matched preset
 * yields its chip + orientation; anything else is Custom. Used at dialog-open
 * time — mp/div cannot be recovered from a plain entry and get separate
 * defaults at the call site.
 */
export function chipForEntry(
  entry: ResolutionEntry | null,
  presets: ResolutionEntry[]
): { chip: RatioChip; orientation: 'landscape' | 'portrait' } {
  if (entry && entry.width > 0 && entry.height > 0) {
    for (const chip of ['1:1', '4:3', '3:2', '16:9'] as const) {
      const ratio = ratioOf(chip)
      if (ratio === null) continue
      if (Math.abs(entry.width / entry.height - ratio) < 1e-6) {
        const orientation: 'landscape' | 'portrait' =
          entry.width >= entry.height ? 'landscape' : 'portrait'
        return { chip, orientation }
      }
    }
  }
  return { chip: 'custom', orientation: 'landscape' }
}

/** True when the entry's dimensions exactly match some preset's dimensions. */
export function matchesPresetDimensions(
  entry: ResolutionEntry | null,
  presets: ResolutionEntry[]
): boolean {
  if (!entry) return false
  return presets.some((p) => p.width === entry.width && p.height === entry.height)
}

/** Distinct non-empty `aspect` strings from a preset list, in list order —
 *  drives the Presets mode aspect dropdown. */
export function presetAspects(presets: ResolutionEntry[]): string[] {
  const out: string[] = []
  for (const p of presets) {
    const a = typeof p.aspect === 'string' ? p.aspect : ''
    if (a && !out.includes(a)) out.push(a)
  }
  return out
}

/** Exact w/h ratio of an entry, or null when the dimensions are not usable. */
export function entryRatio(entry: ResolutionEntry): number | null {
  if (!Number.isFinite(entry.width) || !Number.isFinite(entry.height)) return null
  if (entry.width <= 0 || entry.height <= 0) return null
  return entry.width / entry.height
}
