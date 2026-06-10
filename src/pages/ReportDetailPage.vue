<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import ReportBuilder from '../components/ReportBuilder.vue'
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
const setup = ref({})
const body = ref('')
const report = ref({})
const busy = ref(false)
const drafting = ref(false)
const confirmFinalise = ref(false)

const isFinal = computed(() => report.value.status === 'final')

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
  if (id.value) {
    const res = await api.get(`/reports/${id.value}`)
    report.value = res.data
    setup.value = res.data
    body.value = res.data.body_markdown || ''
  } else if (route.query.client) {
    setup.value = { client_id: Number(route.query.client) }
  }
})

function payload (status) {
  return {
    client_id: Number(setup.value.client_id),
    report_type: setup.value.report_type || 'progress',
    period_start: setup.value.period_start || null,
    period_end: setup.value.period_end || null,
    body_markdown: body.value || null,
    status: status || report.value.status || 'draft'
  }
}

async function save (status) {
  if (!setup.value.client_id) { toast.push('Choose a participant first', 'warning'); return }
  busy.value = true
  try {
    const res = id.value ? await api.put(`/reports/${id.value}`, payload(status)) : await api.post('/reports', payload(status))
    report.value = res.data
    toast.push(status === 'final' ? 'Report finalised' : 'Report saved', 'success')
    if (!id.value) router.replace(`/reports/${res.data.id}`)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function draft () {
  drafting.value = true
  try {
    await api.put(`/reports/${id.value}`, payload())
    const res = await api.post(`/reports/${id.value}/draft`, {})
    report.value = res.data
    body.value = res.data.body_markdown || ''
    toast.push('Draft generated from shift notes — review before finalising', 'success')
  } catch { /* toast via interceptor */ } finally {
    drafting.value = false
  }
}

function downloadPdf () {
  window.open(`/api/v1/reports/${id.value}/pdf?refresh=true`, '_blank')
}

const uploadingCopy = ref(false)

/**
 * Upload the finalised copy of this report to the participant's completed
 * documents, so it can be stored and re-downloaded later.
 */
async function uploadFinalCopy (event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploadingCopy.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', `${(setup.value.report_type || 'progress').replace('_', ' ')} report (final)`)
    fd.append('source_type', 'report')
    fd.append('source_id', String(id.value))
    await api.upload(`/clients/${setup.value.client_id}/documents`, fd)
    toast.push('Final copy saved to the participant’s documents', 'success')
  } catch { /* toast via interceptor */ } finally {
    uploadingCopy.value = false
    event.target.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ id ? 'Report' : 'New report' }}</h1>
      <div class="flex items-center gap-2">
        <StatusBadge v-if="id" :status="report.status || 'draft'" />
        <button v-if="id && body" class="btn-ghost" @click="downloadPdf">PDF</button>
        <label v-if="isFinal" class="btn-ghost cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': uploadingCopy }">
          {{ uploadingCopy ? 'Uploading…' : 'Upload final copy' }}
          <input type="file" class="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" :disabled="uploadingCopy" @change="uploadFinalCopy" />
        </label>
        <button v-if="id && body && !isFinal" class="btn-accent" @click="confirmFinalise = true">Finalise</button>
      </div>
    </div>

    <ReportBuilder v-model="setup" :clients="clients" :locked="isFinal" />

    <AiDraftPanel
      v-if="id && !isFinal"
      :input-text="`${setup.period_start || ''} ${setup.period_end || ''}`"
      :busy="drafting"
      label="Draft report from shifts"
      hint="Each shift in the period is condensed cheaply (Haiku) first, then Sonnet drafts the report aligned to the participant's goals."
      @draft="draft"
    />

    <AgreementEditor v-model="body" :locked="isFinal" />

    <button class="btn-primary" :disabled="busy" @click="save()">{{ busy ? 'Saving…' : 'Save report' }}</button>

    <ConfirmDialog
      :open="confirmFinalise"
      title="Finalise this report?"
      message="Finalised reports are locked. Make sure you have reviewed and edited the draft."
      confirm-label="Finalise"
      @confirm="confirmFinalise = false; save('final')"
      @cancel="confirmFinalise = false"
    />
  </div>
</template>
