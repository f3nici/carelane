<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'
import { openServerFile } from '../composables/nativeFiles.js'
import StatusBadge from '../components/StatusBadge.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const auth = useAuthStore()
const id = computed(() => route.params.id)

const clients = ref([])
const busy = ref(false)
const confirmDelete = ref(false)
const shiftNoteId = ref(null)
const displayName = ref('')

const TYPES = [
  ['injury', 'Injury'], ['illness', 'Illness/medical'], ['medication_error', 'Medication error'],
  ['behaviour', 'Behaviour of concern'], ['property_damage', 'Property damage'],
  ['abuse_neglect', 'Abuse / neglect'], ['restrictive_practice', 'Restrictive practice'],
  ['death', 'Death'], ['absconding', 'Absconding / missing'], ['other', 'Other']
]
const SEVERITIES = ['minor', 'moderate', 'major', 'critical']
const CATEGORIES = [
  ['death', 'Death of a person with disability'],
  ['serious_injury', 'Serious injury of a person with disability'],
  ['abuse_or_neglect', 'Abuse or neglect of a person with disability'],
  ['unlawful_contact', 'Unlawful sexual or physical contact / assault'],
  ['sexual_misconduct', 'Sexual misconduct against a person with disability'],
  ['unauthorised_restrictive_practice', 'Unauthorised use of a restrictive practice']
]
const STATUSES = ['open', 'in_progress', 'closed']

const blank = () => ({
  client_id: route.query.client ? Number(route.query.client) : null,
  reference_no: '', incident_date: new Date().toISOString().slice(0, 10), incident_time: '',
  location: '', incident_type: 'other', severity: 'minor', reportable: 0, reportable_category: '',
  description: '', immediate_actions: '', injuries: '', persons_involved: '', witnesses: '',
  contributing_factors: '', reported_to_ndis: 0, reported_to_ndis_date: '', notified_parties: '',
  follow_up_actions: '', follow_up_due_date: '', status: 'open'
})
const form = reactive(blank())

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
  if (id.value) {
    const res = await api.get(`/incidents/${id.value}`)
    hydrate(res.data)
  }
})

function hydrate (i) {
  for (const k of Object.keys(form)) form[k] = i[k] ?? (typeof form[k] === 'number' ? 0 : '')
  form.reportable = i.reportable ? 1 : 0
  form.reported_to_ndis = i.reported_to_ndis ? 1 : 0
  form.client_id = i.client_id
  shiftNoteId.value = i.shift_note_id
  displayName.value = i.client_display_name
}

function buildPayload () {
  const p = { ...form }
  p.reportable = form.reportable ? 1 : 0
  p.reported_to_ndis = form.reported_to_ndis ? 1 : 0
  p.client_id = Number(form.client_id)
  for (const k of ['reference_no', 'incident_time', 'location', 'reportable_category', 'description',
    'immediate_actions', 'injuries', 'persons_involved', 'witnesses', 'contributing_factors',
    'reported_to_ndis_date', 'notified_parties', 'follow_up_actions', 'follow_up_due_date']) {
    if (p[k] === '') p[k] = null
  }
  if (!p.reportable) { p.reportable_category = null }
  return p
}

async function save () {
  if (!form.client_id) { toast.push('Choose a participant first', 'error'); return }
  busy.value = true
  try {
    const payload = buildPayload()
    let res
    if (id.value) res = await api.put(`/incidents/${id.value}`, payload)
    else res = await api.post('/incidents', payload)
    toast.push('Incident report saved', 'success')
    if (!id.value) router.replace(`/incidents/${res.data.id}`)
    else hydrate(res.data)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

function exportPdf () {
  openServerFile(`/api/v1/incidents/${id.value}/export.pdf`, `incident-${id.value}.pdf`)
}

async function remove () {
  confirmDelete.value = false
  await api.del(`/incidents/${id.value}`)
  toast.push('Incident report archived', 'success')
  router.push('/incidents')
}
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ id ? 'Incident report' : 'New incident report' }}</h1>
        <p v-if="id" class="text-sm text-mid">
          {{ displayName }}
          <router-link v-if="shiftNoteId" :to="`/shifts/${shiftNoteId}`" class="text-accent hover:underline ml-1">· from shift note →</router-link>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <StatusBadge v-if="id" :status="form.status" />
        <button v-if="id && !auth.isDemo" class="btn-ghost" @click="exportPdf">Export PDF</button>
        <button v-if="id" class="btn-danger" @click="confirmDelete = true">Archive</button>
      </div>
    </div>

    <form class="space-y-6" @submit.prevent="save">
      <div class="card space-y-3">
        <h3 class="font-semibold">Incident details</h3>
        <div v-if="!id">
          <label class="label">Participant *</label>
          <select v-model="form.client_id" class="input" required>
            <option :value="null" disabled>Select a participant…</option>
            <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.preferred_name || `${c.first_name} ${c.last_name}` }}</option>
          </select>
        </div>
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="label">Date *</label><input v-model="form.incident_date" type="date" class="input" required /></div>
          <div><label class="label">Time</label><input v-model="form.incident_time" type="time" class="input" /></div>
          <div><label class="label">Reference no.</label><input v-model="form.reference_no" class="input" placeholder="optional" /></div>
        </div>
        <div><label class="label">Location</label><input v-model="form.location" class="input" /></div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="label">Type</label>
            <select v-model="form.incident_type" class="input">
              <option v-for="[v, l] in TYPES" :key="v" :value="v">{{ l }}</option>
            </select>
          </div>
          <div>
            <label class="label">Severity</label>
            <select v-model="form.severity" class="input">
              <option v-for="s in SEVERITIES" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card space-y-3">
        <h3 class="font-semibold">NDIS reportable status</h3>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="form.reportable" type="checkbox" :true-value="1" :false-value="0" class="rounded" />
          This is a reportable incident under the NDIS Commission rules
        </label>
        <template v-if="form.reportable">
          <div>
            <label class="label">Reportable category</label>
            <select v-model="form.reportable_category" class="input">
              <option value="">Select a category…</option>
              <option v-for="[v, l] in CATEGORIES" :key="v" :value="v">{{ l }}</option>
            </select>
          </div>
          <div class="grid sm:grid-cols-2 gap-3">
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.reported_to_ndis" type="checkbox" :true-value="1" :false-value="0" class="rounded" />
              Reported to the NDIS Commission
            </label>
            <div v-if="form.reported_to_ndis"><label class="label">Date reported</label><input v-model="form.reported_to_ndis_date" type="date" class="input" /></div>
          </div>
          <p class="text-xs text-warning">Reportable incidents must be notified to the NDIS Quality and Safeguards Commission within the required timeframe. CareLane records your notification; it does not submit it.</p>
        </template>
      </div>

      <div class="card space-y-3">
        <h3 class="font-semibold">What happened</h3>
        <div><label class="label">Description</label><textarea v-model="form.description" class="input" rows="4" placeholder="Factual account of what occurred" /></div>
        <div><label class="label">Injuries / harm</label><textarea v-model="form.injuries" class="input" rows="2" /></div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label">Persons involved</label><textarea v-model="form.persons_involved" class="input" rows="2" /></div>
          <div><label class="label">Witnesses</label><textarea v-model="form.witnesses" class="input" rows="2" /></div>
        </div>
        <div><label class="label">Immediate actions taken</label><textarea v-model="form.immediate_actions" class="input" rows="3" /></div>
        <div><label class="label">Contributing factors</label><textarea v-model="form.contributing_factors" class="input" rows="2" /></div>
        <div><label class="label">Parties notified (family/guardian, plan manager, supervisor…)</label><textarea v-model="form.notified_parties" class="input" rows="2" /></div>
      </div>

      <div class="card space-y-3">
        <h3 class="font-semibold">Follow-up</h3>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="label">Follow-up status</label>
            <select v-model="form.status" class="input">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ s.replace('_', ' ') }}</option>
            </select>
          </div>
          <div><label class="label">Follow-up due</label><input v-model="form.follow_up_due_date" type="date" class="input" /></div>
        </div>
        <div><label class="label">Follow-up actions</label><textarea v-model="form.follow_up_actions" class="input" rows="3" /></div>
      </div>

      <div class="flex gap-2">
        <button class="btn-primary" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Save incident report' }}</button>
        <router-link to="/incidents" class="btn-ghost">Cancel</router-link>
      </div>
    </form>

    <ConfirmDialog
      :open="confirmDelete"
      title="Archive this incident report?"
      message="The report is soft-deleted and retained per NDIS record-keeping obligations. Restore it later from Deleted items."
      confirm-label="Archive"
      danger
      @confirm="remove"
      @cancel="confirmDelete = false"
    />
  </div>
</template>
