/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import type { ThemeKey } from '@shared/types'

/** A single theme definition. `css` is the CSS module that declares the overrides. */
export interface ThemeDefinition {
  /** Stable key, e.g. 'default' / 'halloween'. */
  key: ThemeKey
  /** Human-readable label for any future UI picker. */
  label: string
  /** CSS module that declares `:root[data-theme="KEY"] { ... }` overrides. */
  css: string
  /**
   * Load the theme's CSS. Eager for the bundled themes so switching is
   * synchronous; a lazy `import()` can be swapped in later without touching
   * callers.
   */
  load(): Promise<void>
}

/**
 * Apply a theme's CSS. Bundled themes are eager (already imported), so this is a
 * no-op that only resolves. Kept async to match the registry's `load()` shape.
 */
function eagerCss(): Promise<void> {
  return Promise.resolve()
}

/**
 * Theme registry. Add a new theme by:
 *   1. creating a `<name>.css` with `:root[data-theme="<key>"] { ... }` overrides,
 *   2. adding an entry here.
 * The `:root` defaults in `theme.css` remain the base for every theme.
 */
export const THEMES: Record<ThemeKey, ThemeDefinition> = {
  default: {
    key: 'default',
    label: 'Default (Blue)',
    css: 'theme-default',
    load: eagerCss
  },
  halloween: {
    key: 'halloween',
    label: 'Halloween',
    css: 'halloween',
    load: eagerCss
  },
  christmas: {
    key: 'christmas',
    label: 'Christmas',
    css: 'christmas',
    load: eagerCss
  }
}

/** All theme keys, in registry order. */
export function themeKeys(): ThemeKey[] {
  return Object.keys(THEMES) as ThemeKey[]
}

/** Theme metadata for any future UI picker. */
export function listThemes(): { key: ThemeKey; label: string }[] {
  return themeKeys().map((key) => ({ key, label: THEMES[key].label }))
}

/**
 * Validate a key against the registry. Throws on unknown keys so a bad persisted
 * or programmatic value fails loudly instead of silently applying nothing.
 */
export function assertThemeKey(key: ThemeKey): asserts key is keyof typeof THEMES {
  if (!(key in THEMES)) {
    throw new Error(`Unknown theme "${key}". Available: ${themeKeys().join(', ')}`)
  }
}

/**
 * Apply a theme to the document. Sets `data-theme` on `<html>` so the CSS
 * variable overrides in each theme's stylesheet take effect. Emits a `theme`
 * event so other renderer code can react if needed.
 */
export function applyTheme(key: ThemeKey): void {
  assertThemeKey(key)
  // Clear any stale theme first so a re-select is idempotent and no leftover
  // data-theme lingers between two custom themes.
  document.documentElement.dataset.theme = key
  document.dispatchEvent(new Event('theme'))
}

/**
 * The currently active theme key, or 'default' when unset. Read by the renderer
 * to reflect state; the source of truth is `data-theme` on `<html>`.
 */
export function currentTheme(): ThemeKey {
  return (document.documentElement.dataset.theme as ThemeKey) || 'default'
}
