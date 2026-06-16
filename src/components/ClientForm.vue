<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['submit'])

const form = reactive({
  first_name: '', last_name: '', preferred_name: '', ndis_number: '', date_of_birth: '',
  phone: '', email: '', address: '', suburb: '', state: 'WA', postcode: '',
  plan_management_type: '', plan_manager_name: '', plan_manager_contact: '', invoice_due_days: '',
  primary_disability: '', communication_needs: '', support_goals: '',
  emergency_contact_name: '', emergency_contact_phone: '', notes: '', active: 1
})

watch(() => props.modelValue, value => {
  if (value?.id) Object.assign(form, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v ?? ''])))
}, { immediate: true })

function submit () {
  const payload = { ...form }
  for (const k of Object.keys(payload)) if (payload[k] === '') payload[k] = null
  payload.active = form.active ? 1 : 0
  payload.state = form.state || 'WA'
  emit('submit', payload)
}
</script>

<template>
  <form class="space-y-6" @submit.prevent="submit">
    <div class="card">
      <h3 class="font-semibold mb-4">Identity</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div><label class="label">First name *</label><input v-model="form.first_name" class="input" required /></div>
        <div><label class="label">Last name *</label><input v-model="form.last_name" class="input" required /></div>
        <div><label class="label">Preferred name</label><input v-model="form.preferred_name" class="input" /></div>
        <div><label class="label">NDIS number (9 digits)</label><input v-model="form.ndis_number" class="input" pattern="\d{9}" /></div>
        <div><label class="label">Date of birth</label><input v-model="form.date_of_birth" type="date" class="input" /></div>
        <div><label class="label">Primary disability</label><input v-model="form.primary_disability" class="input" /></div>
      </div>
    </div>

    <div class="card">
      <h3 class="font-semibold mb-4">Contact</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div><label class="label">Phone</label><input v-model="form.phone" class="input" /></div>
        <div><label class="label">Email</label><input v-model="form.email" type="email" class="input" /></div>
        <div><label class="label">Address</label><input v-model="form.address" class="input" /></div>
        <div><label class="label">Suburb</label><input v-model="form.suburb" class="input" /></div>
        <div><label class="label">State</label><input v-model="form.state" class="input" maxlength="3" /></div>
        <div><label class="label">Postcode</label><input v-model="form.postcode" class="input" /></div>
        <div><label class="label">Emergency contact name</label><input v-model="form.emergency_contact_name" class="input" /></div>
        <div><label class="label">Emergency contact phone</label><input v-model="form.emergency_contact_phone" class="input" /></div>
      </div>
    </div>

    <div class="card">
      <h3 class="font-semibold mb-4">Plan management &amp; invoicing</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label class="label">Plan management</label>
          <select v-model="form.plan_management_type" class="input">
            <option value="">—</option>
            <option value="self">Self-managed</option>
            <option value="plan_managed">Plan-managed</option>
            <option value="ndia_managed">NDIA-managed</option>
          </select>
        </div>
        <div><label class="label">Plan manager name</label><input v-model="form.plan_manager_name" class="input" /></div>
        <div><label class="label">Plan manager contact</label><input v-model="form.plan_manager_contact" class="input" /></div>
        <div><label class="label">Invoice due (days)</label><input v-model="form.invoice_due_days" type="number" min="0" max="365" class="input" placeholder="45" /></div>
      </div>
    </div>

    <div class="card">
      <h3 class="font-semibold mb-4">Support</h3>
      <div class="space-y-4">
        <div><label class="label">Communication needs</label><textarea v-model="form.communication_needs" class="input" rows="2" /></div>
        <div><label class="label">Support goals (drives reports)</label><textarea v-model="form.support_goals" class="input" rows="3" /></div>
        <div><label class="label">Internal notes</label><textarea v-model="form.notes" class="input" rows="3" /></div>
        <label class="flex items-center gap-2 text-sm"><input v-model="form.active" type="checkbox" :true-value="1" :false-value="0" class="accent-primary" /> Active client</label>
      </div>
    </div>

    <button class="btn-primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save client' }}</button>
  </form>
</template>
