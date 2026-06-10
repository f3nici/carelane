<script setup>
import { reactive, watch } from 'vue'
import BillingCodePicker from './BillingCodePicker.vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  clients: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  locked: { type: Boolean, default: false }
})
const emit = defineEmits(['submit'])

const form = reactive({
  client_id: null, shift_date: new Date().toISOString().slice(0, 10), start_time: '', end_time: '',
  duration_hours: null, billing_code_id: null, location: '', support_provided: '', body: '',
  participant_response: '', incident_flag: 0, incident_details: '', follow_up_required: 0,
  billed: 0, finalised: 0
})

watch(() => props.modelValue, value => {
  if (value && Object.keys(value).length) {
    for (const k of Object.keys(form)) if (k in value) form[k] = value[k] ?? (typeof form[k] === 'number' ? 0 : '')
    form.client_id = value.client_id ?? form.client_id
  }
}, { immediate: true })

function submit (finalise = false) {
  const payload = { ...form }
  for (const k of ['start_time', 'end_time', 'location', 'support_provided', 'body', 'participant_response', 'incident_details']) {
    if (payload[k] === '') payload[k] = null
  }
  payload.duration_hours = payload.duration_hours ? Number(payload.duration_hours) : null
  payload.billing_code_id = payload.billing_code_id ? Number(payload.billing_code_id) : null
  payload.client_id = Number(payload.client_id)
  if (finalise) payload.finalised = 1
  emit('submit', payload)
}

defineExpose({ form })
</script>

<template>
  <form class="space-y-6" @submit.prevent="submit(false)">
    <div class="card">
      <h3 class="font-semibold mb-4">Shift details</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label class="label">Participant *</label>
          <select v-model="form.client_id" class="input" :disabled="locked" required>
            <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.preferred_name || `${c.first_name} ${c.last_name}` }}</option>
          </select>
        </div>
        <div><label class="label">Date *</label><input v-model="form.shift_date" type="date" class="input" :disabled="locked" required /></div>
        <div><label class="label">Location</label><input v-model="form.location" class="input" :disabled="locked" /></div>
        <div><label class="label">Start</label><input v-model="form.start_time" type="time" class="input" :disabled="locked" /></div>
        <div><label class="label">End</label><input v-model="form.end_time" type="time" class="input" :disabled="locked" /></div>
        <div><label class="label">Duration (hours)</label><input v-model="form.duration_hours" type="number" step="0.25" min="0" class="input" :disabled="locked" placeholder="auto from times" /></div>
        <div class="lg:col-span-3">
          <label class="label">Support item delivered</label>
          <BillingCodePicker v-model="form.billing_code_id" :client-id="form.client_id" :disabled="locked" />
        </div>
      </div>
    </div>

    <div class="card">
      <h3 class="font-semibold mb-4">What happened</h3>
      <div class="space-y-4">
        <div>
          <label class="label">Support provided (bullets — used for the AI draft)</label>
          <textarea v-model="form.support_provided" class="input font-mono text-xs" rows="5" :disabled="locked" placeholder="- helped prepare lunch&#10;- practised bus route to TAFE&#10;- worked on budgeting goal" />
        </div>
        <div>
          <label class="label">Participant response</label>
          <textarea v-model="form.participant_response" class="input" rows="2" :disabled="locked" />
        </div>
        <div>
          <label class="label">Progress note (final wording — edit the AI draft here)</label>
          <textarea v-model="form.body" class="input" rows="8" :disabled="locked" />
        </div>
      </div>
    </div>

    <div class="card" :class="form.incident_flag ? 'border-danger/40' : ''">
      <div class="flex flex-wrap gap-6">
        <label class="flex items-center gap-2 text-sm"><input v-model="form.incident_flag" type="checkbox" :true-value="1" :false-value="0" :disabled="locked" class="accent-danger" /> Incident occurred</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="form.follow_up_required" type="checkbox" :true-value="1" :false-value="0" :disabled="locked" class="accent-warning" /> Follow-up required</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="form.billed" type="checkbox" :true-value="1" :false-value="0" class="accent-accent" /> Billed / claimed</label>
      </div>
      <div v-if="form.incident_flag" class="mt-4">
        <label class="label">Incident details (retained permanently)</label>
        <textarea v-model="form.incident_details" class="input" rows="3" :disabled="locked" />
      </div>
    </div>

    <div class="flex gap-2">
      <button type="submit" class="btn-primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save draft' }}</button>
      <button v-if="!locked" type="button" class="btn-accent" :disabled="busy || !form.body" title="Finalising locks the note and attributes it to you" @click="submit(true)">Save & finalise</button>
    </div>
  </form>
</template>
