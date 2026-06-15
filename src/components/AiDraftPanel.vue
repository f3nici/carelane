<script setup>
import { computed, ref, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps({
  inputText: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: 'Generate AI draft' },
  hint: { type: String, default: 'AI output is a draft only — review and edit before finalising.' },
  // When set, the panel asks the server for an accurate estimate of the WHOLE
  // assembled prompt (system + template + retrieved context + this record),
  // instead of the rough local count of just the typed text.
  estimateEndpoint: { type: String, default: '' },
  estimatePayload: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['draft'])
const api = useApi()

// Local ~4 chars/token fallback — only the typed text, used until/unless the
// server estimate (which covers everything that is actually sent) arrives.
const localTokens = computed(() => Math.ceil((props.inputText || '').length / 4))
const serverTokens = ref(null)
const displayTokens = computed(() => serverTokens.value ?? localTokens.value)

let timer = null
watch(
  () => [props.estimateEndpoint, props.estimatePayload, props.inputText],
  () => {
    if (!props.estimateEndpoint) { serverTokens.value = null; return }
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        const res = await api.post(props.estimateEndpoint, props.estimatePayload)
        serverTokens.value = res.data?.estimated_tokens ?? null
      } catch { serverTokens.value = null }
    }, 600)
  },
  { deep: true, immediate: true }
)
</script>

<template>
  <div class="card border-accent/30">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="font-semibold text-accent">AI assist</h3>
        <p class="text-xs text-mid mt-1">{{ hint }}</p>
        <p class="text-xs text-mid mt-1">Estimated input: ~{{ displayTokens }} tokens. Only minimal, de-identified context is sent to the Claude API.</p>
      </div>
      <button class="btn-accent" :disabled="busy || disabled" @click="emit('draft')">
        <svg v-if="busy" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
        {{ busy ? 'Drafting…' : label }}
      </button>
    </div>
  </div>
</template>
