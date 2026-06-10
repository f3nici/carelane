<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  client: { type: Object, default: null }
})
const emit = defineEmits(['update:modelValue'])

const q = reactive({
  participant_name: '', ndis_number: '', plan_start: '', plan_end: '',
  plan_management_type: '', supports: '', frequency_hours: '', rates_invoicing: '',
  goals: '', cancellation_policy: '48 hours notice for cancellations; late cancellations may be charged per the NDIS Pricing Arrangements.',
  consent_privacy: 'The participant consents to the collection and secure storage of their information for service delivery. Information is only shared with their consent or as required by law.',
  complaints: 'Complaints can be raised directly with the provider, or with the NDIS Quality and Safeguards Commission on 1800 035 544.',
  ending_agreement: '14 days written notice by either party.',
  start_date: '', end_date: '', review_date: ''
})

watch(() => props.client, c => {
  if (!c) return
  q.participant_name = q.participant_name || c.preferred_name || `${c.first_name} ${c.last_name}`
  q.ndis_number = q.ndis_number || c.ndis_number || ''
  q.plan_start = q.plan_start || c.plan_start || ''
  q.plan_end = q.plan_end || c.plan_end || ''
  q.plan_management_type = q.plan_management_type || c.plan_management_type || ''
  q.goals = q.goals || c.support_goals || ''
}, { immediate: true })

watch(() => props.modelValue, v => {
  if (v && Object.keys(v).length) Object.assign(q, v)
}, { immediate: true })

watch(q, () => emit('update:modelValue', { ...q }), { deep: true, immediate: true })

const fields = [
  { key: 'participant_name', label: 'Participant name', type: 'text' },
  { key: 'ndis_number', label: 'NDIS number', type: 'text' },
  { key: 'plan_management_type', label: 'Plan management type', type: 'select', options: ['self', 'plan_managed', 'ndia_managed'] },
  { key: 'start_date', label: 'Agreement start', type: 'date' },
  { key: 'end_date', label: 'Agreement end', type: 'date' },
  { key: 'review_date', label: 'Review date', type: 'date' },
  { key: 'supports', label: 'Supports to be delivered (billing codes, description)', type: 'textarea' },
  { key: 'frequency_hours', label: 'Frequency and hours', type: 'text' },
  { key: 'rates_invoicing', label: 'Rates and how/when invoicing happens', type: 'textarea' },
  { key: 'goals', label: 'Goals the supports work toward', type: 'textarea' },
  { key: 'cancellation_policy', label: 'Cancellation policy and notice periods', type: 'textarea' },
  { key: 'consent_privacy', label: 'Consent and privacy', type: 'textarea' },
  { key: 'complaints', label: 'Complaints process', type: 'textarea' },
  { key: 'ending_agreement', label: 'How to end the agreement', type: 'textarea' }
]
</script>

<template>
  <div class="card">
    <h3 class="font-semibold mb-1">Intake questionnaire</h3>
    <p class="text-xs text-mid mb-4">These answers (and only these) are sent to Claude to draft the agreement.</p>
    <div class="grid sm:grid-cols-2 gap-4">
      <div v-for="f in fields" :key="f.key" :class="f.type === 'textarea' ? 'sm:col-span-2' : ''">
        <label class="label">{{ f.label }}</label>
        <textarea v-if="f.type === 'textarea'" v-model="q[f.key]" class="input" rows="2" />
        <select v-else-if="f.type === 'select'" v-model="q[f.key]" class="input">
          <option value="">—</option>
          <option v-for="o in f.options" :key="o" :value="o">{{ o.replace('_', ' ') }}</option>
        </select>
        <input v-else v-model="q[f.key]" :type="f.type" class="input" />
      </div>
    </div>
  </div>
</template>
