<script setup>
import { ref, onMounted } from 'vue'
import { usePortalApi } from '../../composables/usePortalApi.js'
import { openServerFile } from '../../composables/nativeFiles.js'

/** The participant's completed documents, with authenticated downloads. */
const api = usePortalApi()
const documents = ref([])
const loading = ref(true)

const DOC_TYPE_LABELS = {
  media_consent: 'Media consent',
  consent_to_share: 'Consent to share information',
  service_agreement: 'Service agreement',
  risk_assessment: 'Risk assessment',
  behaviour_support_plan: 'Behaviour support plan',
  report: 'Report',
  other: 'Document'
}

function typeLabel (t) {
  return DOC_TYPE_LABELS[t] || 'Document'
}

function niceDate (iso) {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return iso }
}

/** Cookie-authenticated download (share sheet in the native app). */
function download (id) {
  openServerFile(`/api/v1/portal/documents/${id}/file`)
}

onMounted(async () => {
  try {
    documents.value = (await api.get('/documents')).data
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div>
    <h1 class="text-xl font-heading font-semibold mb-4">Your documents</h1>

    <p v-if="loading" class="text-mid text-sm">Loading…</p>
    <p v-else-if="!documents.length" class="card text-mid text-sm">
      There are no documents to show yet.
    </p>

    <ul v-else class="space-y-3">
      <li v-for="doc in documents" :key="doc.id" class="card flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="font-medium truncate">{{ doc.title }}</p>
          <p class="text-xs text-mid mt-0.5">
            {{ typeLabel(doc.doc_type) }}
            <span v-if="doc.issue_date"> · Issued {{ niceDate(doc.issue_date) }}</span>
          </p>
        </div>
        <button class="btn-ghost text-xs shrink-0" @click="download(doc.id)">Download</button>
      </li>
    </ul>
  </div>
</template>
