<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import StatusBadge from './StatusBadge.vue'

const props = defineProps({
  clientId: { type: [String, Number], required: true }
})
const emit = defineEmits(['count'])

const api = useApi()
const toast = useToastStore()

const documents = ref([])
const uploading = ref(false)
const editingId = ref(null)

const DOC_TYPES = [
  { value: 'media_consent', label: 'Media consent' },
  { value: 'consent_to_share', label: 'Consent to share information' },
  { value: 'consent_general', label: 'General consent' },
  { value: 'service_agreement', label: 'Signed service agreement' },
  { value: 'behaviour_support_plan', label: 'Behaviour support plan' },
  { value: 'risk_assessment', label: 'Risk assessment' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'identification', label: 'Identification' },
  { value: 'other', label: 'Other' }
]
const typeLabel = v => DOC_TYPES.find(t => t.value === v)?.label || 'Other'

const upload = reactive({ doc_type: 'media_consent', issue_date: '', expiry_date: '' })
const edit = reactive({ title: '', doc_type: 'other', issue_date: '', expiry_date: '' })

async function load () {
  const res = await api.get(`/clients/${props.clientId}/documents`)
  documents.value = res.data
  emit('count', documents.value.length)
}
onMounted(load)

async function uploadDocument (event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', file.name.replace(/\.[^.]+$/, ''))
    fd.append('doc_type', upload.doc_type)
    if (upload.issue_date) fd.append('issue_date', upload.issue_date)
    if (upload.expiry_date) fd.append('expiry_date', upload.expiry_date)
    const res = await api.upload(`/clients/${props.clientId}/documents`, fd)
    documents.value = [res.data, ...documents.value]
    emit('count', documents.value.length)
    upload.issue_date = ''
    upload.expiry_date = ''
    toast.push('Document saved', 'success')
  } catch { /* toast via interceptor */ } finally {
    uploading.value = false
    event.target.value = ''
  }
}

function startEdit (doc) {
  editingId.value = doc.id
  Object.assign(edit, {
    title: doc.title, doc_type: doc.doc_type || 'other',
    issue_date: doc.issue_date || '', expiry_date: doc.expiry_date || ''
  })
}

async function saveEdit () {
  const res = await api.put(`/clients/${props.clientId}/documents/${editingId.value}`, {
    title: edit.title.trim() || 'Document',
    doc_type: edit.doc_type,
    issue_date: edit.issue_date || null,
    expiry_date: edit.expiry_date || null
  })
  documents.value = documents.value.map(d => d.id === res.data.id ? res.data : d)
  editingId.value = null
  toast.push('Document updated', 'success')
}

function downloadDocument (doc) {
  window.open(`/api/v1/clients/${props.clientId}/documents/${doc.id}/file`, '_blank')
}

async function removeDocument (doc) {
  await api.del(`/clients/${props.clientId}/documents/${doc.id}`)
  documents.value = documents.value.filter(d => d.id !== doc.id)
  emit('count', documents.value.length)
  toast.push('Document archived', 'success')
}

function formatSize (bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3 gap-3 flex-wrap">
      <h3 class="font-semibold">Completed documents &amp; consents</h3>
      <label class="btn-primary cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': uploading }">
        {{ uploading ? 'Uploading…' : '+ Upload document' }}
        <input type="file" class="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" :disabled="uploading" @change="uploadDocument" />
      </label>
    </div>
    <p class="text-xs text-mid mb-3">Store consent forms, signed agreements and other completed paperwork. Set a type and expiry so lapsing consents surface on the dashboard. Files are served only to you.</p>

    <div class="grid sm:grid-cols-3 gap-3 mb-4 rounded-lg bg-white/5 p-3">
      <div>
        <label class="label">Type for next upload</label>
        <select v-model="upload.doc_type" class="input">
          <option v-for="t in DOC_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </div>
      <div><label class="label">Issue date</label><input v-model="upload.issue_date" type="date" class="input" /></div>
      <div><label class="label">Expiry date</label><input v-model="upload.expiry_date" type="date" class="input" /></div>
    </div>

    <p v-if="!documents.length" class="text-sm text-mid">No completed documents yet.</p>
    <ul v-else class="divide-y divide-white/10">
      <li v-for="d in documents" :key="d.id" class="py-3">
        <div v-if="editingId === d.id" class="space-y-3">
          <div class="grid sm:grid-cols-2 gap-3">
            <div><label class="label">Title</label><input v-model="edit.title" class="input" /></div>
            <div>
              <label class="label">Type</label>
              <select v-model="edit.doc_type" class="input">
                <option v-for="t in DOC_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>
            <div><label class="label">Issue date</label><input v-model="edit.issue_date" type="date" class="input" /></div>
            <div><label class="label">Expiry date</label><input v-model="edit.expiry_date" type="date" class="input" /></div>
          </div>
          <div class="flex gap-2">
            <button class="btn-primary" @click="saveEdit">Save</button>
            <button class="btn-ghost" @click="editingId = null">Cancel</button>
          </div>
        </div>
        <div v-else class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm truncate flex items-center gap-2">
              {{ d.title }}
              <StatusBadge v-if="d.expiry_status === 'expired'" status="expired" />
              <StatusBadge v-else-if="d.expiry_status === 'expiring'" status="expiring" />
            </p>
            <p class="text-xs text-mid">
              {{ typeLabel(d.doc_type) }}
              <span v-if="d.issue_date"> · issued {{ d.issue_date }}</span>
              <span v-if="d.expiry_date"> · expires {{ d.expiry_date }}</span>
              <span v-if="formatSize(d.size_bytes)"> · {{ formatSize(d.size_bytes) }}</span>
            </p>
          </div>
          <div class="flex gap-3 shrink-0 text-xs">
            <button class="text-accent hover:underline" @click="startEdit(d)">edit</button>
            <button class="text-accent hover:underline" @click="downloadDocument(d)">download</button>
            <button class="text-danger hover:underline" @click="removeDocument(d)">remove</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
