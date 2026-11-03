/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { HuggingFaceSource } from './huggingface'
import { CivitaiSource } from './civitai'
import { registerSource } from './registry'

/**
 * The single canonical registration point for model sources. Adding a second
 * source means adding `registerSource(new NewSource())` HERE — not a
 * self-registration inside the new file's module scope, which would only run
 * if that file is imported (and the only importer is this file), keeping the
 * wiring invariant in one place.
 */
export function registerSources(): void {
  registerSource(new HuggingFaceSource())
  registerSource(new CivitaiSource())
}

// Module-scope registration runs whenever ANY module imports from './sources'
// (hub.ts and models.ts both do) — the registry is populated before the first
// buildCatalog() call and before any download. If this module is never
// loaded, the registry stays empty and buildCatalog's loud tripwire fires
// (see the P2.3 note in plans/model-downloader-source.md).
registerSources()

export { getSourceForUrl, getSourceForEntry, sourceNames } from './registry'
export type { ModelSource, RepoFile, DownloadParams } from './model-source'
