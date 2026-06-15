<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps({
  modelValue: { type: [Number, null], default: null },
  clientId: { type: [Number, null], default: null },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const api = useApi()
const codes = ref([])

// v-model on the <select> so Vue re-syncs the selected <option> once the codes
// load asynchronously — a plain :value binding stays unselected because it isn't
// re-applied when only the option list changes.
const selected = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

// Only the billing codes assigned to the selected participant are offered.
watch(() => props.clientId, async (clientId, prev) => {
  // Switching from one participant to *another* invalidates a code chosen for the
  // old one. Initial hydration of an existing note goes null → id (prev == null)
  // and must keep the saved code instead of wiping it.
  if (prev != null && clientId !== prev && props.modelValue != null) emit('update:modelValue', null)
  if (!clientId) { codes.value = []; return }
  const res = await api.get(`/clients/${clientId}/billing-codes`)
  codes.value = res.data
}, { immediate: true })

/** Prefer the client's custom rate over the standard cap when one is set. */
function priceLabel (c) {
  const rate = c.custom_rate ?? c.price_cap_standard
  return rate ? ` ($${rate}/${c.unit})` : ''
}
</script>

<template>
  <select
    class="input"
    v-model="selected"
    :disabled="disabled"
  >
    <option :value="null">{{ clientId ? '— No billing code —' : '— Select a participant first —' }}</option>
    <option v-for="c in codes" :key="c.id" :value="c.id">
      {{ c.code }} — {{ c.name }}{{ priceLabel(c) }}
    </option>
  </select>
</template>
