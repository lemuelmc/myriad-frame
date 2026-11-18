/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { ref } from 'vue'

/**
 * Shared bridge for "use generated image as input/reference" actions.
 *
 * ChatPanel owns the composer channel state (`refImages`, `inputImages`, caps,
 * dedupe, and the optional resize/crop editor). The lightbox — a sibling
 * component mounted in App.vue — needs to trigger the same attach flow for
 * the image it is previewing. This module provides:
 *
 *  - A module-level callback that ChatPanel registers (its `attachWithOptionalEdit`).
 *  - Reactive refs (`inputChannelEnabled`, `refChannelEnabled`) that ChatPanel
 *    keeps in sync with its channel-gating computeds, so the lightbox can
 *    disable its buttons when the current model doesn't accept that channel.
 *  - A shared `useGeneratedImageAs(path, channel)` action both components call.
 *
 * This mirrors how `confirm.ts` decouples dialog callers from `<ConfirmDialog />`.
 */

/** The attach callback ChatPanel registers — takes a path list + channel. */
type AttachCallback = (paths: string[], channel: 'input' | 'reference') => Promise<void>

let attachCb: AttachCallback | null = null

/** Reactive channel-enablement flags synced by ChatPanel. */
export const inputChannelEnabled = ref(false)
export const refChannelEnabled = ref(false)
/** Reactive image-upscale-enablement flag synced by ChatPanel (mirrors the
 *  `image_upscaler.show` sampling descriptor). */
export const upscaleEnabled = ref(false)
/** Reactive list of glob patterns accepted by the upscale channel, synced by
 *  ChatPanel from the `image_upscaler.accepts` sampling descriptor. Empty when
 *  the descriptor carries no `accepts` (meaning: allow any path). */
export const upscaleAccepts = ref<string[]>([])

/**
 * True when `path`'s extension matches one of the glob patterns (e.g.
 * `"*.png"`), or when `patterns` is empty (no restriction). Case-insensitive.
 * Mirrors the `accepts`-glob convention used by the media pickers: patterns
 * are `*.<ext>` globs, so this compares the path's lowercased extension.
 */
export function pathMatchesAccepts(path: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return true
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  const ext = path.slice(dot + 1).toLowerCase()
  return patterns.some((g) => g.toLowerCase().replace(/^\*\./, '') === ext)
}

/**
 * ChatPanel calls this on mount (and keeps the refs in sync via a watcher).
 * Passes its `attachWithOptionalEdit` as the callback.
 */
export function registerComposerAttach(cb: AttachCallback): void {
  attachCb = cb
}

/**
 * Shared action: attach a generated image to the composer's input or
 * reference channel, offering the resize/crop editor first.
 *
 * Safe to call from both ChatPanel (preview hover buttons) and
 * ImageLightbox (fullscreen tool strip). No-ops if no callback is registered
 * (e.g. called before ChatPanel mounts — unreachable in practice).
 */
export async function useGeneratedImageAs(
  path: string,
  channel: 'input' | 'reference'
): Promise<void> {
  if (!attachCb) return
  await attachCb([path], channel)
}
