<script setup>
import { ref, computed } from 'vue'
import { renderMarkdown } from '../composables/useMarkdown.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  locked: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const preview = ref(false)
const html = computed(() => renderMarkdown(props.modelValue))
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold">Document body</h3>
      <div class="flex gap-1">
        <button type="button" class="btn-ghost text-xs" :class="!preview ? '!bg-primary/20 !text-white' : ''" @click="preview = false">Edit</button>
        <button type="button" class="btn-ghost text-xs" :class="preview ? '!bg-primary/20 !text-white' : ''" @click="preview = true">Preview</button>
      </div>
    </div>
    <textarea
      v-if="!preview"
      :value="modelValue"
      class="input font-mono text-xs"
      rows="22"
      :disabled="locked"
      placeholder="Markdown body — generate an AI draft or write it yourself"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <div v-else class="prose-dark text-sm space-y-2 max-h-[34rem] overflow-y-auto" v-html="html" />
  </div>
</template>

<style scoped>
.prose-dark :deep(h1) { @apply text-xl font-semibold mt-4 mb-2 }
.prose-dark :deep(h2) { @apply text-lg font-semibold mt-4 mb-1 text-accent }
.prose-dark :deep(h3) { @apply font-semibold mt-3 mb-1 }
.prose-dark :deep(ul) { @apply list-disc pl-5 space-y-1 }
.prose-dark :deep(p) { @apply mb-2 }
</style>
