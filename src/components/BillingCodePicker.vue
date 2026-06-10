<script setup>
import { ref, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps({
  modelValue: { type: [Number, null], default: null },
  clientId: { type: [Number, null], default: null },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const api = useApi()
const codes = ref([])
let firstLoad = true

// Only the billing codes assigned to the selected participant are offered.
watch(() => props.clientId, async (clientId, prev) => {
  // switching to a different participant invalidates a code chosen for the old one
  if (!firstLoad && clientId !== prev && props.modelValue != null) emit('update:modelValue', null)
  firstLoad = false
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
    :value="props.modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', $event.target.value ? Number($event.target.value) : null)"
  >
    <option :value="null">{{ clientId ? '— No billing code —' : '— Select a participant first —' }}</option>
    <option v-for="c in codes" :key="c.id" :value="c.id">
      {{ c.code }} — {{ c.name }}{{ priceLabel(c) }}
    </option>
  </select>
</template>
