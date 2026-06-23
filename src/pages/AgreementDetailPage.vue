<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import AgreementQuestionnaire from '../components/AgreementQuestionnaire.vue'
import AgreementEditor from '../components/AgreementEditor.vue'
import AiDraftPanel from '../components/AiDraftPanel.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const id = computed(() => route.params.id)

const clients = ref([])
const templates = ref([])
const templateId = ref('')
const title = ref('')
const clientId = ref(null)
const status = ref('draft')
const startDate = ref('')
const endDate = ref('')
const reviewDate = ref('')
const questionnaire = ref({})
const body = ref('')
const agreement = ref({})
const busy = ref(false)
const drafting = ref(false)
const confirmSign = ref(false)

const selectedClient = computed(() => clients.value.find(c => c.id === Number(clientId.value)) || null)
const signed = computed(() => !!agreement.value.signed_by_client)

// The agreement's dates live in one place (the top card). They are folded into
// the questionnaire object sent to Claude so the drafted clauses reference them,
// and persisted in questionnaire_json (review_date has no dedicated column).
const draftQuestionnaire = computed(() => ({
  ...questionnaire.value,
  start_date: startDate.value || null,
  end_date: endDate.value || null,
  review_date: reviewDate.value || null
}))

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
  try {
    const t = await api.get('/templates', { template_type: 'agreement', active: 'true', per_page: 100 })
    templates.value = t.data
    templateId.value = t.data.find(x => x.is_default)?.id ?? ''
  } catch { /* templates optional */ }
  if (id.value) {
    const res = await api.get(`/agreements/${id.value}`)
    setFrom(res.data)
  } else if (route.query.client) {
    clientId.value = Number(route.query.client)
  }
})

function setFrom (a) {
  agreement.value = a
  title.value = a.title
  clientId.value = a.client_id
  status.value = a.status
  startDate.value = a.start_date || ''
  endDate.value = a.end_date || ''
  body.value = a.body_markdown || ''
  try { questionnaire.value = a.questionnaire_json ? JSON.parse(a.questionnaire_json) : {} } catch { questionnaire.value = {} }
  reviewDate.value = questionnaire.value.review_date || ''
}

function payload () {
  return {
    client_id: Number(clientId.value),
    title: title.value || `Service agreement — ${selectedClient.value?.preferred_name || ''}`.trim(),
    status: status.value,
    start_date: startDate.value || null,
    end_date: endDate.value || null,
    questionnaire_json: draftQuestionnaire.value,
    body_markdown: body.value || null
  }
}

async function save () {
  if (!clientId.value) { toast.push('Choose a participant first', 'warning'); return }
  busy.value = true
  try {
    const res = id.value ? await api.put(`/agreements/${id.value}`, payload()) : await api.post('/agreements', payload())
    setFrom(res.data)
    toast.push('Agreement saved', 'success')
    if (!id.value) router.replace(`/agreements/${res.data.id}`)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function draft () {
  drafting.value = true
  try {
    await api.put(`/agreements/${id.value}`, payload())
    const res = await api.post(`/agreements/${id.value}/draft`, templateId.value ? { template_id: Number(templateId.value) } : {})
    setFrom(res.data)
    toast.push('Draft generated — review every clause before signing', 'success')
  } catch { /* toast via interceptor */ } finally {
    drafting.value = false
  }
}

async function sign () {
  confirmSign.value = false
  await api.put(`/agreements/${id.value}`, payload())
  const res = await api.post(`/agreements/${id.value}/sign`, {})
  setFrom(res.data)
  toast.push('Agreement recorded as signed', 'success')
}

function downloadPdf () {
  window.open(`/api/v1/agreements/${id.value}/pdf?refresh=true`, '_blank')
}

async function toggleArchive () {
  if (!id.value) return
  busy.value = true
  try {
    const res = await api.post(`/agreements/${id.value}/${agreement.value.archived_at ? 'unarchive' : 'archive'}`, {})
    setFrom(res.data)
    toast.push(agreement.value.archived_at ? 'Agreement archived' : 'Agreement unarchived', 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

const uploadingCopy = ref(false)

/**
 * Upload the signed copy of this agreement to the participant's completed
 * documents, so it can be stored and re-downloaded later.
 */
async function uploadSignedCopy (event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploadingCopy.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', `${title.value || 'Service agreement'} (signed)`)
    fd.append('source_type', 'agreement')
    fd.append('source_id', String(id.value))
    await api.upload(`/clients/${clientId.value}/documents`, fd)
    toast.push('Signed copy saved to the participant’s documents', 'success')
  } catch { /* toast via interceptor */ } finally {
    uploadingCopy.value = false
    event.target.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ id ? 'Service agreement' : 'New service agreement' }}</h1>
      <div class="flex items-center gap-2">
        <StatusBadge v-if="id" :status="status" />
        <span v-if="agreement.archived_at" class="pill bg-white/10 text-mid">Archived</span>
        <button v-if="id" class="btn-ghost" :disabled="busy" @click="toggleArchive">{{ agreement.archived_at ? 'Unarchive' : 'Archive' }}</button>
        <button v-if="id && body" class="btn-ghost" @click="downloadPdf">PDF</button>
        <label v-if="signed" class="btn-ghost cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': uploadingCopy }">
          {{ uploadingCopy ? 'Uploading…' : 'Upload signed copy' }}
          <input type="file" class="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" :disabled="uploadingCopy" @change="uploadSignedCopy" />
        </label>
        <button v-if="id && body && !signed" class="btn-accent" @click="confirmSign = true">Mark signed</button>
      </div>
    </div>

    <div class="card">
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="lg:col-span-2"><label class="label">Title</label><input v-model="title" class="input" :disabled="signed" placeholder="Service agreement — name" /></div>
        <div>
          <label class="label">Participant</label>
          <select v-model="clientId" class="input" :disabled="!!id">
            <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.preferred_name || `${c.first_name} ${c.last_name}` }}</option>
          </select>
        </div>
        <div>
          <label class="label">Status</label>
          <select v-model="status" class="input">
            <option v-for="s in ['draft', 'active', 'expired', 'cancelled']" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div><label class="label">Start date</label><input v-model="startDate" type="date" class="input" :disabled="signed" /></div>
        <div>
          <label class="label">End date <span class="text-mid font-normal">(optional)</span></label>
          <input v-model="endDate" type="date" class="input" :disabled="signed" />
        </div>
        <div><label class="label">Review date</label><input v-model="reviewDate" type="date" class="input" :disabled="signed" /></div>
      </div>
      <p class="text-xs text-mid mt-3">Most agreements don't have a fixed end — leave <strong>End date</strong> blank and set a <strong>Review date</strong> to revisit it instead.</p>
    </div>

    <AgreementQuestionnaire v-if="!signed" v-model="questionnaire" :client="selectedClient" />

    <div v-if="id && !signed && templates.length" class="card">
      <label class="label">Template</label>
      <select v-model="templateId" class="input max-w-md">
        <option value="">Automatic (default template)</option>
        <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}{{ t.is_default ? ' (default)' : '' }}</option>
      </select>
      <p class="text-xs text-mid mt-1">Claude follows this template's headings and house wording when drafting. <router-link to="/templates" class="text-accent hover:underline">Manage templates</router-link></p>
    </div>

    <AiDraftPanel
      v-if="id && !signed"
      :input-text="JSON.stringify(draftQuestionnaire)"
      :estimate-endpoint="id ? `/agreements/${id}/draft/estimate` : ''"
      :estimate-payload="{ questionnaire: draftQuestionnaire, template_id: templateId ? Number(templateId) : undefined }"
      :busy="drafting"
      label="Draft agreement"
      hint="Sonnet fills the selected template from your questionnaire plus relevant guideline excerpts. You review, edit and the participant signs."
      @draft="draft"
    />

    <AgreementEditor v-model="body" :locked="signed" />

    <button class="btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save agreement' }}</button>

    <ConfirmDialog
      :open="confirmSign"
      title="Record participant signature?"
      message="Confirm the participant has reviewed and signed this agreement. The body and terms will be locked."
      confirm-label="Mark signed"
      @confirm="sign"
      @cancel="confirmSign = false"
    />
  </div>
</template>
