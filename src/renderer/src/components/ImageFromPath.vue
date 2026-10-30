<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLightboxStore } from '../stores/lightbox'

const props = defineProps<{ path: string; alt?: string; max?: number; clickable?: boolean }>()

const src = ref('')
onMounted(async () => {
  try {
    src.value = await window.api.imageFromPath(props.path)
  } catch {
    src.value = ''
  }
})

function openLightbox(e: Event): void {
  if (!props.clickable || !src.value) return
  useLightboxStore().open(props.path, e.currentTarget as HTMLElement)
}
</script>

<template>
  <img
    v-if="src"
    :src="src"
    :alt="alt ?? ''"
    :style="max ? { maxWidth: max + 'px' } : {}"
    class="chat-img"
    :class="{ clickable }"
    :tabindex="clickable ? 0 : undefined"
    @click="openLightbox"
    @keydown.enter="openLightbox"
  />
  <div v-else class="chat-img missing mono">image unavailable</div>
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
</style>
