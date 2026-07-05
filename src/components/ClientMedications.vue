<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import StatusBadge from './StatusBadge.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps({
  clientId: { type: [String, Number], required: true },
  // Support workers view care records read-only (no add/edit/archive controls).
  readonly: { type: Boolean, default: false }
})
const emit = defineEmits(['count'])

const api = useApi()
const toast = useToastStore()

const records = ref([])
const showNew = ref(false)
const editingId = ref(null)
const pendingDelete = ref(null)

const ROUTES = ['oral', 'topical', 'inhaled', 'injection', 'sublingual', 'other']
const STATUSES = ['administered', 'refused', 'missed', 'withheld', 'self_administered']

const blank = () => ({
  medication_name: '', dose: '', route: 'oral', administered_date: new Date().toISOString().slice(0, 10),
  administered_time: '', prn: 0, status: 'administered', reason: '', notes: '', witnessed_by: ''
})
const form = reactive(blank())

async function load () {
  const res = await api.get(`/clients/${props.clientId}/medications`)
  records.value = res.data
  emit('count', records.value.length)
}
onMounted(load)

function startNew () {
  Object.assign(form, blank())
  editingId.value = null
  showNew.value = true
}

function startEdit (r) {
  Object.assign(form, {
    medication_name: r.medication_name, dose: r.dose || '', route: r.route || 'oral',
    administered_date: r.administered_date, administered_time: r.administered_time || '',
    prn: r.prn ? 1 : 0, status: r.status, reason: r.reason || '', notes: r.notes || '', witnessed_by: r.witnessed_by || ''
  })
  editingId.value = r.id
  showNew.value = true
}

function payload () {
  return {
    medication_name: form.medication_name.trim(),
    dose: form.dose.trim() || null,
    route: form.route || null,
    administered_date: form.administered_date,
    administered_time: form.administered_time || null,
    prn: form.prn ? 1 : 0,
    status: form.status,
    reason: form.reason.trim() || null,
    notes: form.notes.trim() || null,
    witnessed_by: form.witnessed_by.trim() || null
  }
}

async function save () {
  if (!form.medication_name.trim()) return
  try {
    if (editingId.value) await api.put(`/clients/${props.clientId}/medications/${editingId.value}`, payload())
    else await api.post(`/clients/${props.clientId}/medications`, payload())
    toast.push('Medication record saved', 'success')
    showNew.value = false
    editingId.value = null
    await load()
  } catch { /* toast via interceptor */ }
}

function confirmDelete (r) { pendingDelete.value = r }

async function doDelete () {
  const r = pendingDelete.value
  pendingDelete.value = null
  if (!r) return
  await api.del(`/clients/${props.clientId}/medications/${r.id}`)
  toast.push('Medication record archived', 'success')
  await load()
}
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="font-semibold">Medication administration</h3>
        <p class="text-xs text-mid">A medication administration record (MAR). The reason and notes are encrypted at rest.</p>
      </div>
      <button v-if="!readonly" class="btn-primary" @click="startNew">+ Log administration</button>
    </div>

    <form v-if="showNew" class="rounded-lg border border-white/10 p-4 mb-4 space-y-3" @submit.prevent="save">
      <p class="text-sm font-medium">{{ editingId ? 'Edit record' : 'New administration' }}</p>
      <div class="grid sm:grid-cols-2 gap-3">
        <div><label class="label">Medication *</label><input v-model="form.medication_name" class="input" placeholder="e.g. Paracetamol" required /></div>
        <div><label class="label">Dose</label><input v-model="form.dose" class="input" placeholder="e.g. 500mg" /></div>
      </div>
      <div class="grid sm:grid-cols-3 gap-3">
        <div><label class="label">Date *</label><input v-model="form.administered_date" type="date" class="input" required /></div>
        <div><label class="label">Time</label><input v-model="form.administered_time" type="time" class="input" /></div>
        <div>
          <label class="label">Route</label>
          <select v-model="form.route" class="input"><option v-for="r in ROUTES" :key="r" :value="r">{{ r }}</option></select>
        </div>
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        <div>
          <label class="label">Outcome</label>
          <select v-model="form.status" class="input"><option v-for="s in STATUSES" :key="s" :value="s">{{ s.replace('_', ' ') }}</option></select>
        </div>
        <div><label class="label">Witnessed by</label><input v-model="form.witnessed_by" class="input" /></div>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.prn" type="checkbox" :true-value="1" :false-value="0" class="rounded" /> PRN (as required)
      </label>
      <div><label class="label">Reason (for PRN / refusal)</label><input v-model="form.reason" class="input" /></div>
      <div><label class="label">Notes</label><textarea v-model="form.notes" class="input" rows="2" /></div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">Save</button>
        <button class="btn-ghost" type="button" @click="showNew = false">Cancel</button>
      </div>
    </form>

    <p v-if="!records.length" class="text-sm text-mid">No medication records yet.</p>
    <ul class="divide-y divide-white/10">
      <li v-for="r in records" :key="r.id" class="py-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm flex items-center gap-2 flex-wrap">
            <span class="font-medium">{{ r.medication_name }}</span>
            <span v-if="r.dose" class="text-mid">{{ r.dose }}</span>
            <StatusBadge :status="r.status" />
            <span v-if="r.prn" class="pill bg-white/10 text-mid">PRN</span>
          </p>
          <p class="text-xs text-mid mt-1">
            {{ r.administered_date }}<span v-if="r.administered_time"> {{ r.administered_time }}</span>
            <span v-if="r.route"> · {{ r.route }}</span>
            <span v-if="r.witnessed_by"> · witnessed by {{ r.witnessed_by }}</span>
          </p>
          <p v-if="r.reason" class="text-xs text-mid mt-1">Reason: {{ r.reason }}</p>
          <p v-if="r.notes" class="text-xs text-mid mt-1 whitespace-pre-wrap">{{ r.notes }}</p>
        </div>
        <div v-if="!readonly" class="flex gap-3 shrink-0 text-xs">
          <button class="text-accent hover:underline" @click="startEdit(r)">edit</button>
          <button class="text-danger hover:underline" @click="confirmDelete(r)">archive</button>
        </div>
      </li>
    </ul>

    <ConfirmDialog
      :open="!!pendingDelete"
      title="Archive this medication record?"
      message="The record is soft-deleted and retained for record-keeping. Restore it later from Deleted items."
      confirm-label="Archive"
      danger
      @confirm="doDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
