<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  clients: { type: Array, default: () => [] },
  locked: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const form = reactive({
  client_id: null,
  report_type: 'progress',
  period_start: '',
  period_end: '',
  status: 'draft'
})

watch(() => props.modelValue, v => {
  if (v && Object.keys(v).length) for (const k of Object.keys(form)) if (k in v) form[k] = v[k] ?? form[k]
}, { immediate: true })

watch(form, () => emit('update:modelValue', { ...form }), { deep: true, immediate: true })
</script>

<template>
  <div class="card">
    <h3 class="font-semibold mb-4">Report setup</h3>
    <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div>
        <label class="label">Participant</label>
        <select v-model="form.client_id" class="input" :disabled="locked">
          <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.preferred_name || `${c.first_name} ${c.last_name}` }}</option>
        </select>
      </div>
      <div>
        <label class="label">Type</label>
        <select v-model="form.report_type" class="input" :disabled="locked">
          <option v-for="t in ['progress', 'plan_review', 'incident', 'general']" :key="t" :value="t">{{ t.replace('_', ' ') }}</option>
        </select>
      </div>
      <div><label class="label">Period start</label><input v-model="form.period_start" type="date" class="input" :disabled="locked" /></div>
      <div><label class="label">Period end</label><input v-model="form.period_end" type="date" class="input" :disabled="locked" /></div>
    </div>
  </div>
</template>
