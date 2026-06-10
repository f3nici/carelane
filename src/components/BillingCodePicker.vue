<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps({
  modelValue: { type: [Number, null], default: null }
})
const emit = defineEmits(['update:modelValue'])

const api = useApi()
const codes = ref([])

onMounted(async () => {
  const res = await api.get('/billing-codes', { active: 'true', per_page: 100 })
  codes.value = res.data
})
</script>

<template>
  <select class="input" :value="props.modelValue" @change="emit('update:modelValue', $event.target.value ? Number($event.target.value) : null)">
    <option :value="null">— No billing code —</option>
    <option v-for="c in codes" :key="c.id" :value="c.id">
      {{ c.code }} — {{ c.name }}{{ c.price_cap_standard ? ` ($${c.price_cap_standard}/${c.unit})` : '' }}
    </option>
  </select>
</template>
