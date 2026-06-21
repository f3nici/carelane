<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useOfflineStore } from '../stores/offline.js'
import ShiftNoteEditor from '../components/ShiftNoteEditor.vue'
import AiDraftPanel from '../components/AiDraftPanel.vue'
import PhotoUploader from '../components/PhotoUploader.vue'
import PhotoGallery from '../components/PhotoGallery.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const offline = useOfflineStore()
const id = computed(() => route.params.id)

const shift = ref({})
const clients = ref([])
const busy = ref(false)
const drafting = ref(false)
const editor = ref(null)
const squareStatus = ref(null)
const invoice = ref(null)
const invoicing = ref(false)
const incidentReport = ref(null)
const promoting = ref(false)
// Set when this note is being written for a clocked-out scheduled shift.
const fromSchedule = computed(() => route.query.from_schedule ? Number(route.query.from_schedule) : null)

onMounted(async () => {
  // Offline note capture: the participant list comes from the offline cache when
  // there's no signal (the server fetch would just fail).
  if (offline.supported && !navigator.onLine) {
    clients.value = offline.clients
    return
  }
  try {
    const c = await api.get('/clients', { active: 'true', per_page: 100 })
    clients.value = c.data
  } catch (err) {
    // Lost connectivity loading the form → fall back to the cached roster.
    if (!err.response && offline.supported) { clients.value = offline.clients; return }
    throw err
  }
  if (id.value) {
    const res = await api.get(`/shifts/${id.value}`)
    shift.value = res.data
    loadSquare()
    loadIncident()
  } else if (fromSchedule.value) {
    // Prefill participant, date and the actual clocked times from the roster.
    const res = await api.get(`/schedule/${fromSchedule.value}/note-prefill`)
    shift.value = res.data
  } else if (route.query.client) {
    shift.value = { client_id: Number(route.query.client) }
  }
})

async function save (payload) {
  busy.value = true
  try {
    let res
    if (id.value) {
      res = await api.put(`/shifts/${id.value}`, payload)
    } else {
      // New note. Editing the schedule-linked endpoint keeps the two in step.
      const endpoint = fromSchedule.value ? `/schedule/${fromSchedule.value}/note` : '/shifts'
      // Offline field capture: park new notes in IndexedDB and sync on reconnect.
      if (offline.supported && !navigator.onLine) return queueOffline(endpoint, payload)
      try {
        const created = await api.post(endpoint, payload)
        res = { data: fromSchedule.value ? created.data.note : created.data }
      } catch (err) {
        // Lost connectivity mid-save → fall back to the offline queue.
        if (!err.response && offline.supported) return queueOffline(endpoint, payload)
        throw err
      }
    }
    shift.value = res.data
    toast.push(payload.finalised ? 'Shift note finalised' : 'Shift note saved', 'success')
    if (!id.value) router.replace(`/shifts/${res.data.id}`)
    // Refresh Square status/invoice so the option appears as soon as the note is
    // finalised, without needing to leave and re-open the note.
    loadSquare()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

/** Park a new note in the offline queue and return to the notes list. */
async function queueOffline (endpoint, payload) {
  // A draft finalisation makes no sense offline — it is stored as a draft.
  const draft = { ...payload, finalised: 0 }
  await offline.enqueue({ endpoint, payload: draft, shiftDate: payload.shift_date })
  busy.value = false
  toast.push('Saved offline — it will sync automatically when you reconnect', 'success')
  router.push(navigator.onLine ? '/shifts' : { name: 'offline' })
}

async function reopen () {
  if (!id.value) return
  busy.value = true
  try {
    const res = await api.put(`/shifts/${id.value}`, { finalised: 0 })
    shift.value = res.data
    toast.push('Shift note reopened — edit and finalise again', 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function toggleArchive () {
  if (!id.value) return
  busy.value = true
  try {
    const res = await api.post(`/shifts/${id.value}/${shift.value.archived_at ? 'unarchive' : 'archive'}`, {})
    shift.value = res.data
    toast.push(shift.value.archived_at ? 'Shift note archived' : 'Shift note unarchived', 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

/** Load Square config + any existing invoice for this shift (best-effort). */
async function loadSquare () {
  // After creating a note the route param lags a tick behind, so fall back to the
  // saved note's id to load Square status without waiting for a remount.
  const shiftId = id.value || shift.value.id
  if (!shiftId) return
  try {
    const [s, inv] = await Promise.all([
      api.get('/invoices/square/status'),
      api.get('/invoices', { shift_note_id: shiftId })
    ])
    squareStatus.value = s.data
    invoice.value = inv.data[0] || null
  } catch { /* invoicing is optional */ }
}

/** Create a draft invoice in Square from this shift note. */
async function generateInvoice () {
  if (!id.value) return
  invoicing.value = true
  try {
    const res = await api.post(`/invoices/from-shift/${id.value}`, {})
    invoice.value = res.data.invoice
    toast.push('Draft invoice created in Square — review and send it from Square', 'success')
  } catch { /* toast via interceptor */ } finally {
    invoicing.value = false
  }
}

/** Cancel the existing Square invoice and create a replacement draft. */
async function recreateInvoice () {
  if (!id.value) return
  const confirmed = window.confirm(
    'This will cancel the existing Square invoice and create a new draft. The old invoice will be voided in Square. Continue?'
  )
  if (!confirmed) return
  invoicing.value = true
  try {
    const res = await api.post(`/invoices/from-shift/${id.value}/recreate`, {})
    invoice.value = res.data.invoice
    toast.push('Old invoice cancelled — new draft created in Square', 'success')
  } catch { /* toast via interceptor */ } finally {
    invoicing.value = false
  }
}

/** Load any structured incident report already linked to this shift note. */
async function loadIncident () {
  const shiftId = id.value || shift.value.id
  if (!shiftId) return
  try {
    const res = await api.get('/incidents', { shift_note_id: shiftId, per_page: 1 })
    incidentReport.value = res.data[0] || null
  } catch { /* best-effort */ }
}

/** Promote this incident-flagged note into a structured incident report. */
async function promoteIncident () {
  if (!id.value) return
  promoting.value = true
  try {
    const res = await api.post(`/incidents/from-shift/${id.value}`, {})
    toast.push('Incident report created — add the structured details', 'success')
    router.push(`/incidents/${res.data.id}`)
  } catch { /* toast via interceptor */ } finally {
    promoting.value = false
  }
}

async function draft () {
  if (!id.value) {
    toast.push('Save the shift first, then generate the draft', 'warning')
    return
  }
  // persist current bullets before drafting so the server uses the latest input
  const bullets = editor.value?.form?.support_provided
  drafting.value = true
  try {
    await api.put(`/shifts/${id.value}`, { support_provided: bullets || null, participant_response: editor.value?.form?.participant_response || null })
    const res = await api.post(`/shifts/${id.value}/draft`, {})
    shift.value = res.data
    toast.push('Draft generated — review and edit before finalising', 'success')
  } catch { /* toast via interceptor */ } finally {
    drafting.value = false
  }
}
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ id ? 'Shift note' : 'New shift note' }}</h1>
      <div class="flex items-center gap-2">
        <StatusBadge v-if="id" :status="shift.finalised ? 'finalised' : 'draft'" />
        <span v-if="shift.archived_at" class="pill bg-white/10 text-mid">Archived</span>
        <button v-if="id" class="btn-ghost" :disabled="busy" @click="toggleArchive">{{ shift.archived_at ? 'Unarchive' : 'Archive' }}</button>
      </div>
    </div>

    <AiDraftPanel
      v-if="!shift.finalised"
      :input-text="editor?.form?.support_provided || ''"
      :estimate-endpoint="id ? `/shifts/${id}/draft/estimate` : ''"
      :estimate-payload="{ bullets: editor?.form?.support_provided || '' }"
      :busy="drafting"
      :disabled="!id || !(editor?.form?.support_provided)"
      label="Draft note from bullets"
      hint="Haiku turns your bullets into a clean, person-centred progress note. You review and finalise."
      @draft="draft"
    />

    <ShiftNoteEditor ref="editor" :model-value="shift" :clients="clients" :busy="busy" :locked="!!shift.finalised" @submit="save" @reopen="reopen" />

    <div v-if="id && shift.incident_flag" class="card border-danger/40 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="font-semibold text-danger">Incident report</h3>
        <StatusBadge v-if="incidentReport" :status="incidentReport.status" />
      </div>
      <template v-if="incidentReport">
        <p class="text-sm text-mid">A structured incident report is linked to this note.</p>
        <router-link :to="`/incidents/${incidentReport.id}`" class="btn-primary inline-block">Open incident report →</router-link>
      </template>
      <template v-else>
        <p class="text-sm text-mid">
          This note is flagged as an incident. Promote it to a structured incident report with NDIS
          reportable-incident fields and a follow-up status — the description is seeded from the note.
        </p>
        <button class="btn-primary" :disabled="promoting" @click="promoteIncident">{{ promoting ? 'Creating…' : 'Create incident report' }}</button>
      </template>
    </div>

    <div v-if="id && shift.finalised && squareStatus && squareStatus.configured" class="card space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="font-semibold">Square invoice</h3>
        <span v-if="invoice" class="pill bg-success/15 text-success">{{ invoice.status || 'DRAFT' }}</span>
      </div>
      <template v-if="invoice">
        <p class="text-sm text-mid">
          {{ invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'Draft invoice' }}
          · {{ invoice.currency }} {{ Number(invoice.amount).toFixed(2) }}
          · created {{ (invoice.created_at || '').slice(0, 10) }}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <a v-if="invoice.public_url" :href="invoice.public_url" target="_blank" rel="noopener noreferrer" class="text-accent text-sm hover:underline">Open in Square →</a>
          <p v-else class="text-xs text-mid">This draft lives in your Square account — open Square to review and send it.</p>
          <button
            v-if="invoice.status !== 'CANCELED' && squareStatus.enabled"
            class="btn-ghost text-sm text-warning"
            :disabled="invoicing"
            @click="recreateInvoice"
          >{{ invoicing ? 'Recreating…' : 'Recreate invoice' }}</button>
        </div>
      </template>
      <template v-else>
        <p class="text-sm text-mid">
          Create a <strong>draft</strong> invoice in Square for this shift using the participant's rate for the
          selected billing code. Nothing is sent — you review and send it from Square.
        </p>
        <button
          class="btn-primary"
          :disabled="invoicing || !squareStatus.enabled"
          @click="generateInvoice"
        >{{ invoicing ? 'Creating…' : 'Create draft invoice in Square' }}</button>
        <p v-if="!squareStatus.enabled" class="text-xs text-warning">Enable Square invoicing in Settings first.</p>
      </template>
    </div>

    <div v-if="id" class="card">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Photos</h3>
        <PhotoUploader :shift-id="id" @uploaded="p => shift.photos = [...(shift.photos || []), p]" />
      </div>
      <PhotoGallery :shift-id="id" :photos="shift.photos || []" @deleted="pid => shift.photos = shift.photos.filter(p => p.id !== pid)" />
    </div>
  </div>
</template>
