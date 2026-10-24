<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ path: string; alt?: string; max?: number }>()

const src = ref('')
onMounted(async () => {
  try {
    src.value = await window.api.imageFromPath(props.path)
  } catch {
    src.value = ''
  }
})
</script>

<template>
  <img
    v-if="src"
    :src="src"
    :alt="alt ?? ''"
    :style="max ? { maxWidth: max + 'px' } : {}"
    class="chat-img"
  />
  <div v-else class="chat-img missing mono">image unavailable</div>
</template>

<style scoped>
.chat-img {
  border-radius: var(--radius);
  display: block;
}
.chat-img.missing {
  color: var(--text-faint);
  padding: 12px;
  border: 1px dashed var(--border);
  width: 120px;
  text-align: center;
}
</style>
