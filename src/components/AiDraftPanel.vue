<script setup>
import { computed } from 'vue'

const props = defineProps({
  inputText: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: 'Generate AI draft' },
  hint: { type: String, default: 'AI output is a draft only — review and edit before finalising.' }
})
const emit = defineEmits(['draft'])

// ~4 chars/token heuristic, mirrored server-side
const estimatedTokens = computed(() => Math.ceil((props.inputText || '').length / 4))
</script>

<template>
  <div class="card border-accent/30">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="font-semibold text-accent">AI assist</h3>
        <p class="text-xs text-mid mt-1">{{ hint }}</p>
        <p class="text-xs text-mid mt-1">Estimated input: ~{{ estimatedTokens }} tokens. Only minimal, de-identified context is sent to the Claude API.</p>
      </div>
      <button class="btn-accent" :disabled="busy || disabled" @click="emit('draft')">
        <svg v-if="busy" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
        {{ busy ? 'Drafting…' : label }}
      </button>
    </div>
  </div>
</template>
