<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import ShiftNoteEditor from '../components/ShiftNoteEditor.vue'
import AiDraftPanel from '../components/AiDraftPanel.vue'
import PhotoUploader from '../components/PhotoUploader.vue'
import PhotoGallery from '../components/PhotoGallery.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const id = computed(() => route.params.id)

const shift = ref({})
const clients = ref([])
const busy = ref(false)
const drafting = ref(false)
const editor = ref(null)
// Set when this note is being written for a clocked-out scheduled shift.
const fromSchedule = computed(() => route.query.from_schedule ? Number(route.query.from_schedule) : null)

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
  if (id.value) {
    const res = await api.get(`/shifts/${id.value}`)
    shift.value = res.data
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
    } else if (fromSchedule.value) {
      // Create the note against the scheduled shift so the two stay linked.
      const created = await api.post(`/schedule/${fromSchedule.value}/note`, payload)
      res = { data: created.data.note }
    } else {
      res = await api.post('/shifts', payload)
    }
    shift.value = res.data
    toast.push(payload.finalised ? 'Shift note finalised' : 'Shift note saved', 'success')
    if (!id.value) router.replace(`/shifts/${res.data.id}`)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
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

    <div v-if="id" class="card">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Photos</h3>
        <PhotoUploader :shift-id="id" @uploaded="p => shift.photos = [...(shift.photos || []), p]" />
      </div>
      <PhotoGallery :shift-id="id" :photos="shift.photos || []" @deleted="pid => shift.photos = shift.photos.filter(p => p.id !== pid)" />
    </div>
  </div>
</template>
