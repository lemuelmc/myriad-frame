/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { toast } from './toast'

/** Save As dialog via main; on success toast with an "Open folder" action. */
export async function saveImageAs(path: string): Promise<void> {
  try {
    const saved = await window.api.saveImage(path)
    if (saved) {
      toast('Image saved', 'ok', 5000, {
        label: 'Open folder',
        run: () => {
          // A stale main/preload (app not restarted since the API was added)
          // leaves showInFolder missing or unregistered — surface that
          // instead of failing silently.
          if (typeof window.api.showInFolder !== 'function') {
            toast('Restart the app to enable "Open folder"', 'error', 6000)
            return
          }
          window.api
            .showInFolder(saved)
            .then((ok) => {
              if (!ok) toast('File no longer exists', 'error')
            })
            .catch((err) => {
              toast(
                `Could not open folder: ${err instanceof Error ? err.message : String(err)}`,
                'error',
                6000
              )
            })
        }
      })
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 6000)
  }
}
