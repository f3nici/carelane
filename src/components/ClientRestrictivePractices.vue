<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps({
  clientId: { type: [String, Number], required: true }
})
const emit = defineEmits(['count'])

const api = useApi()
const toast = useToastStore()

const records = ref([])
const showNew = ref(false)
const editingId = ref(null)
const pendingDelete = ref(null)

const TYPES = ['chemical', 'physical', 'mechanical', 'environmental', 'seclusion']

const blank = () => ({
  practice_type: 'environmental', used_at_date: new Date().toISOString().slice(0, 10), used_at_time: '',
  duration_minutes: '', authorised: 0, authorisation_ref: '', reported_to_commission: 0,
  description: '', antecedent: '', alternatives_tried: '', outcome: ''
})
const form = reactive(blank())

async function load () {
  const res = await api.get(`/clients/${props.clientId}/restrictive-practices`)
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
    practice_type: r.practice_type, used_at_date: r.used_at_date, used_at_time: r.used_at_time || '',
    duration_minutes: r.duration_minutes ?? '', authorised: r.authorised ? 1 : 0,
    authorisation_ref: r.authorisation_ref || '', reported_to_commission: r.reported_to_commission ? 1 : 0,
    description: r.description || '', antecedent: r.antecedent || '', alternatives_tried: r.alternatives_tried || '', outcome: r.outcome || ''
  })
  editingId.value = r.id
  showNew.value = true
}

function payload () {
  return {
    practice_type: form.practice_type,
    used_at_date: form.used_at_date,
    used_at_time: form.used_at_time || null,
    duration_minutes: form.duration_minutes === '' || form.duration_minutes == null ? null : Number(form.duration_minutes),
    authorised: form.authorised ? 1 : 0,
    authorisation_ref: form.authorisation_ref.trim() || null,
    reported_to_commission: form.reported_to_commission ? 1 : 0,
    description: form.description.trim() || null,
    antecedent: form.antecedent.trim() || null,
    alternatives_tried: form.alternatives_tried.trim() || null,
    outcome: form.outcome.trim() || null
  }
}

async function save () {
  try {
    if (editingId.value) await api.put(`/clients/${props.clientId}/restrictive-practices/${editingId.value}`, payload())
    else await api.post(`/clients/${props.clientId}/restrictive-practices`, payload())
    toast.push('Restrictive-practice record saved', 'success')
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
  await api.del(`/clients/${props.clientId}/restrictive-practices/${r.id}`)
  toast.push('Record archived', 'success')
  await load()
}
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="font-semibold">Restrictive practices</h3>
        <p class="text-xs text-mid">NDIS-regulated register of any restrictive practice used. Narrative fields are encrypted at rest.</p>
      </div>
      <button class="btn-primary" @click="startNew">+ Log use</button>
    </div>

    <form v-if="showNew" class="rounded-lg border border-white/10 p-4 mb-4 space-y-3" @submit.prevent="save">
      <p class="text-sm font-medium">{{ editingId ? 'Edit record' : 'Log restrictive practice' }}</p>
      <div class="grid sm:grid-cols-3 gap-3">
        <div>
          <label class="label">Type</label>
          <select v-model="form.practice_type" class="input"><option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option></select>
        </div>
        <div><label class="label">Date *</label><input v-model="form.used_at_date" type="date" class="input" required /></div>
        <div><label class="label">Time</label><input v-model="form.used_at_time" type="time" class="input" /></div>
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        <div><label class="label">Duration (minutes)</label><input v-model="form.duration_minutes" type="number" min="0" class="input" /></div>
        <div><label class="label">Authorisation reference (BSP)</label><input v-model="form.authorisation_ref" class="input" /></div>
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="form.authorised" type="checkbox" :true-value="1" :false-value="0" class="rounded" /> Authorised in a behaviour support plan
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="form.reported_to_commission" type="checkbox" :true-value="1" :false-value="0" class="rounded" /> Reported to NDIS Commission
        </label>
      </div>
      <div><label class="label">What was done</label><textarea v-model="form.description" class="input" rows="2" /></div>
      <div><label class="label">Antecedent (trigger / behaviour)</label><textarea v-model="form.antecedent" class="input" rows="2" /></div>
      <div><label class="label">Alternatives tried first</label><textarea v-model="form.alternatives_tried" class="input" rows="2" /></div>
      <div><label class="label">Outcome</label><textarea v-model="form.outcome" class="input" rows="2" /></div>
      <p v-if="!form.authorised" class="text-xs text-warning">An unauthorised restrictive practice is a reportable incident — record a matching incident report.</p>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">Save</button>
        <button class="btn-ghost" type="button" @click="showNew = false">Cancel</button>
      </div>
    </form>

    <p v-if="!records.length" class="text-sm text-mid">No restrictive-practice records.</p>
    <ul class="divide-y divide-white/10">
      <li v-for="r in records" :key="r.id" class="py-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm flex items-center gap-2 flex-wrap">
            <span class="font-medium capitalize">{{ r.practice_type }}</span>
            <span v-if="r.authorised" class="pill bg-success/15 text-success">authorised</span>
            <span v-else class="pill bg-danger/15 text-danger">unauthorised</span>
            <span v-if="r.reported_to_commission" class="pill bg-white/10 text-mid">reported</span>
          </p>
          <p class="text-xs text-mid mt-1">
            {{ r.used_at_date }}<span v-if="r.used_at_time"> {{ r.used_at_time }}</span>
            <span v-if="r.duration_minutes"> · {{ r.duration_minutes }} min</span>
            <span v-if="r.authorisation_ref"> · BSP {{ r.authorisation_ref }}</span>
          </p>
          <p v-if="r.description" class="text-xs text-mid mt-1 whitespace-pre-wrap">{{ r.description }}</p>
        </div>
        <div class="flex gap-3 shrink-0 text-xs">
          <button class="text-accent hover:underline" @click="startEdit(r)">edit</button>
          <button class="text-danger hover:underline" @click="confirmDelete(r)">archive</button>
        </div>
      </li>
    </ul>

    <ConfirmDialog
      :open="!!pendingDelete"
      title="Archive this record?"
      message="The record is soft-deleted and retained for record-keeping. Restore it later from Deleted items."
      confirm-label="Archive"
      danger
      @confirm="doDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
