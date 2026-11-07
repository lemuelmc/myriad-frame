<!--
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useLightboxStore } from '../stores/lightbox'
import { toast } from '../toast'

const props = defineProps<{ path: string; alt?: string; max?: number; clickable?: boolean }>()

const src = ref('')

// Browser-decodable containers render as an inline <video> player; the
// lightbox stays image-only.
const isVideo = /\.(mp4|webm|mov)$/i.test(props.path)
// sd-cli vid_gen writes Motion-JPEG .avi (man.txt: single-file video outputs
// support .avi/.webm/animated .webp; the bundled runtime has no ffmpeg muxer,
// so .mp4 is not writable). Chromium cannot demux AVI, so the component shows
// a poster frame extracted from the MJPEG stream and opens the file in the
// system player on click.
const isAvi = /\.avi$/i.test(props.path)

const posterUrl = ref('')
let posterObjectUrl = ''

// Extract the first JFIF frame from the Motion-JPEG AVI. Each frame is a
// standalone baseline JPEG: scan for the SOI marker (FF D8 FF), then its EOI
// (FF D9) — baseline entropy data escapes literal 0xFF bytes as FF 00, so the
// first FF D9 after SOI is the true end of the frame.
function extractPoster(dataUrl: string): void {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    let start = -1
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        start = i
        break
      }
    }
    if (start < 0) return
    let end = -1
    for (let i = start + 2; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
        end = i + 2
        break
      }
    }
    if (end < 0) return
    const blob = new Blob([bytes.subarray(start, end)], { type: 'image/jpeg' })
    posterObjectUrl = URL.createObjectURL(blob)
    posterUrl.value = posterObjectUrl
  } catch {
    posterUrl.value = ''
  }
}

onMounted(async () => {
  try {
    src.value = await window.api.imageFromPath(props.path)
    if (isAvi && src.value) extractPoster(src.value)
  } catch {
    src.value = ''
  }
})

onBeforeUnmount(() => {
  if (posterObjectUrl) {
    URL.revokeObjectURL(posterObjectUrl)
    posterObjectUrl = ''
  }
})

function openLightbox(e: Event): void {
  // Defensive guard: the lightbox is image-only (it renders an <img> via the
  // data-URL path). Videos render in the dedicated <video> branch which never
  // binds this handler, but the guard keeps a future binding from opening a
  // broken lightbox.
  if (isVideo || isAvi) return
  if (!props.clickable || !src.value) return
  useLightboxStore().open(props.path, e.currentTarget as HTMLElement)
}

async function openInPlayer(): Promise<void> {
  // A stale main/preload (app not restarted since the API was added) leaves
  // openPath missing or unregistered — surface that instead of failing silently.
  if (typeof window.api.openPath !== 'function') {
    toast('Restart the app to enable "Open video"', 'error', 6000)
    return
  }
  try {
    const ok = await window.api.openPath(props.path)
    if (!ok) toast('Could not open the video in the system player', 'error', 6000)
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 6000)
  }
}
</script>

<template>
  <video
    v-if="src && isVideo"
    :src="src"
    controls
    preload="metadata"
    :style="max ? { maxWidth: max + 'px' } : {}"
    class="chat-img chat-video"
  />
  <!-- Motion-JPEG .avi: Chromium cannot demux AVI, so render the extracted
       first frame as a poster and hand playback to the system player. -->
  <button
    v-else-if="src && isAvi && posterUrl"
    class="chat-img avi-poster"
    :style="max ? { maxWidth: max + 'px' } : {}"
    title="Open video in system player"
    @click="openInPlayer"
  >
    <img :src="posterUrl" :alt="alt ?? 'generated video'" />
    <span class="play-badge" aria-hidden="true"></span>
  </button>
  <div v-else-if="src && isAvi" class="chat-img avi-fallback">
    <button class="avi-open" @click="openInPlayer">Open video</button>
  </div>
  <img
    v-else-if="src"
    :src="src"
    :alt="alt ?? ''"
    :style="max ? { maxWidth: max + 'px' } : {}"
    class="chat-img"
    :class="{ clickable }"
    :tabindex="clickable ? 0 : undefined"
    @click="openLightbox"
    @keydown.enter="openLightbox"
  />
  <div v-else class="chat-img missing mono">media unavailable</div>
</template>

<style scoped>
.chat-img {
  border-radius: var(--radius);
  display: block;
}
.chat-img.clickable {
  cursor: zoom-in;
}
.chat-img.clickable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.chat-img.missing {
  color: var(--text-faint);
  padding: 12px;
  border: 1px dashed var(--border);
  width: 120px;
  text-align: center;
}
.chat-video {
  border-radius: var(--radius);
  max-height: 320px;
}
.avi-poster {
  position: relative;
  display: block;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}
.avi-poster img {
  display: block;
  border-radius: var(--radius);
  max-width: 100%;
  max-height: 320px;
  width: auto;
}
.play-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.35);
}
.play-badge::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 55%;
  transform: translate(-50%, -50%);
  border-style: solid;
  border-width: 9px 0 9px 15px;
  border-color: transparent transparent transparent #fff;
}
.avi-fallback {
  color: var(--text-faint);
  padding: 12px;
  border: 1px dashed var(--border);
  text-align: center;
}
.avi-open {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
</style>
