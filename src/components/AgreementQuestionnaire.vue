<script setup>
import { reactive, watch, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useIntegrations } from '../composables/useIntegrations.js'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  client: { type: Object, default: null }
})
const emit = defineEmits(['update:modelValue'])

const api = useApi()
const { aiActive, ensureLoaded } = useIntegrations()
onMounted(ensureLoaded)
// Remember the last auto-generated supports text so we only refresh it while the
// operator hasn't hand-edited the field.
let lastAutoFill = ''

const q = reactive({
  participant_name: '', ndis_number: '',
  plan_management_type: '', supports: '', frequency_hours: '', rates_invoicing: '',
  goals: '', cancellation_policy: '48 hours notice for cancellations; late cancellations may be charged per the NDIS Pricing Arrangements.',
  consent_privacy: 'The participant consents to the collection and secure storage of their information for service delivery. Information is only shared with their consent or as required by law.',
  complaints: 'Complaints can be raised directly with the provider, or with the NDIS Quality and Safeguards Commission on 1800 035 544.',
  ending_agreement: '14 days written notice by either party.'
})

/**
 * Prefill "Supports to be delivered" from the participant's assigned billing
 * codes. Leaves the field alone once it's been hand-edited.
 * @param {number} clientId
 */
async function populateSupports (clientId) {
  if (!clientId) return
  if (q.supports && q.supports.trim() && q.supports !== lastAutoFill) return
  try {
    const res = await api.get(`/clients/${clientId}/billing-codes`)
    const lines = res.data.map(c => {
      const rate = c.custom_rate ?? c.price_cap_standard
      const rateStr = rate != null ? ` ($${Number(rate).toFixed(2)}/${c.unit || 'H'})` : ''
      return `- ${c.code} — ${c.name}${rateStr}`
    })
    if (lines.length) { q.supports = lines.join('\n'); lastAutoFill = q.supports } else if (q.supports === lastAutoFill) { q.supports = ''; lastAutoFill = '' }
  } catch { /* assigned codes are optional */ }
}

watch(() => props.client, c => {
  if (!c) return
  q.participant_name = q.participant_name || c.preferred_name || `${c.first_name} ${c.last_name}`
  q.ndis_number = q.ndis_number || c.ndis_number || ''
  q.plan_management_type = q.plan_management_type || c.plan_management_type || ''
  q.goals = q.goals || c.support_goals || ''
  populateSupports(c.id)
}, { immediate: true })

watch(() => props.modelValue, v => {
  if (v && Object.keys(v).length) Object.assign(q, v)
}, { immediate: true })

watch(q, () => emit('update:modelValue', { ...q }), { deep: true, immediate: true })

const fields = [
  { key: 'participant_name', label: 'Participant name', type: 'text' },
  { key: 'ndis_number', label: 'NDIS number', type: 'text' },
  { key: 'plan_management_type', label: 'Plan management type', type: 'select', options: ['self', 'plan_managed', 'ndia_managed'] },
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
    <p v-if="aiActive" class="text-xs text-mid mb-4">These answers (and only these) are sent to Claude to draft the agreement.</p>
    <p v-else class="text-xs text-mid mb-4">Structured intake details for this participant's service agreement.</p>
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
