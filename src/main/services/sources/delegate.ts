/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { downloadModel } from '../downloads'
import type { DownloadParams } from './model-source'

/**
 * The shared default-delegation helper: adapts `DownloadParams` into the
 * generic download manager's `downloadModel` call. Every dedicated source
 * class implements `download()` itself and calls THIS helper to use the
 * manager's staging / size-verify / provider-subdir / in-flight-registry /
 * progress machinery — no source subclasses another, and a new source never
 * touches the download pipeline.
 *
 * Deliberate adaptation contract:
 * - `headers` and `filename` are the only params forwarded — the things a
 *   source threads into the transport / storage (auth / custom headers, and
 *   the stored-filename override for sources whose download URLs carry no
 *   filename in the path — see DownloadParams.filename).
 * - `onProgress` is NOT forwarded: the manager already broadcasts model
 *   progress via its single `notifyModelProgress` broadcaster; forwarding
 *   would double-broadcast the renderer.
 * - `signal` is NOT forwarded: the manager owns the in-flight AbortController
 *   and drives Cancel/Pause; there is no external signal to supply.
 * - `destPath` is NOT forwarded: the manager resolves the staged temp + final
 *   destination internally from `type`/`provider`/`url`.
 *
 * The delegation assumes plain, non-signed HTTP (the manager always downloads
 * fresh — no Range resume for models). A source with signed/expiry-bound URLs
 * must override `download()` entirely and drive its own transport instead of
 * calling this helper.
 */
export async function delegateDownload(params: DownloadParams): Promise<string> {
  return downloadModel(params.type, params.url, params.provider, params.force ?? false, {
    headers: params.headers,
    filename: params.filename
  })
}
