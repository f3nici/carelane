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
const title = ref('')
const clientId = ref(null)
const status = ref('draft')
const startDate = ref('')
const endDate = ref('')
const questionnaire = ref({})
const body = ref('')
const agreement = ref({})
const busy = ref(false)
const drafting = ref(false)
const confirmSign = ref(false)

const selectedClient = computed(() => clients.value.find(c => c.id === Number(clientId.value)) || null)
const signed = computed(() => !!agreement.value.signed_by_client)

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
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
}

function payload () {
  return {
    client_id: Number(clientId.value),
    title: title.value || `Service agreement — ${selectedClient.value?.preferred_name || ''}`.trim(),
    status: status.value,
    start_date: startDate.value || questionnaire.value.start_date || null,
    end_date: endDate.value || questionnaire.value.end_date || null,
    questionnaire_json: questionnaire.value,
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
    const res = await api.post(`/agreements/${id.value}/draft`)
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
        <div><label class="label">End date</label><input v-model="endDate" type="date" class="input" :disabled="signed" /></div>
      </div>
    </div>

    <AgreementQuestionnaire v-if="!signed" v-model="questionnaire" :client="selectedClient" />

    <AiDraftPanel
      v-if="id && !signed"
      :input-text="JSON.stringify(questionnaire)"
      :busy="drafting"
      label="Draft agreement"
      hint="Sonnet fills the agreement template from your questionnaire plus relevant guideline excerpts. You review, edit and the participant signs."
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
