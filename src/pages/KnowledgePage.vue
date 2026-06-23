<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useIntegrations } from '../composables/useIntegrations.js'
import { useToastStore } from '../stores/toast.js'
import KnowledgeSearch from '../components/KnowledgeSearch.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const { aiActive, ensureLoaded } = useIntegrations()
const toast = useToastStore()
const documents = ref([])
const title = ref('')
const category = ref('guideline')
const busy = ref(false)
const fileInput = ref(null)

async function load () {
  const res = await api.get('/documents')
  documents.value = res.data
}

onMounted(() => { load(); ensureLoaded() })

async function upload (event) {
  const file = event.target.files?.[0]
  if (!file) return
  busy.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    form.append('title', title.value || file.name.replace(/\.pdf$/i, ''))
    form.append('category', category.value)
    await api.upload('/documents', form)
    title.value = ''
    toast.push('Uploaded — indexing locally in the background', 'success')
    load()
    setTimeout(load, 8000)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function reindex (id) {
  toast.push('Re-indexing…', 'info')
  await api.post(`/documents/${id}/reindex`)
  toast.push('Re-indexed', 'success')
  load()
}

async function remove (id) {
  await api.del(`/documents/${id}`)
  load()
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">Knowledge base</h1>
    <p class="text-sm text-mid max-w-2xl">Upload NDIS guidelines and policy PDFs. They are chunked and embedded <strong>locally</strong> for instant semantic search{{ aiActive ? ', and used as grounding context for AI drafting' : '' }}.</p>

    <div class="card flex flex-wrap items-end gap-3">
      <div><label class="label">Title</label><input v-model="title" class="input w-64" placeholder="e.g. NDIS Pricing Arrangements 2025-26" /></div>
      <div>
        <label class="label">Category</label>
        <select v-model="category" class="input">
          <option v-for="c in ['guideline', 'policy', 'price_guide', 'template', 'other']" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <label class="btn-primary cursor-pointer">
        <input ref="fileInput" type="file" accept="application/pdf" class="hidden" @change="upload" />
        {{ busy ? 'Uploading…' : '+ Upload PDF' }}
      </label>
    </div>

    <KnowledgeSearch />

    <div class="card !p-0 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-mid border-b border-white/10">
            <th class="p-3">Title</th><th class="p-3">Category</th><th class="p-3">Pages</th><th class="p-3">Chunks</th><th class="p-3">Status</th><th class="p-3"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!documents.length"><td colspan="6" class="p-4 text-mid">No documents uploaded yet.</td></tr>
          <tr v-for="d in documents" :key="d.id" class="border-b border-white/5 hover:bg-white/5">
            <td class="p-3">{{ d.title }}</td>
            <td class="p-3 text-xs text-mid">{{ d.category }}</td>
            <td class="p-3">{{ d.page_count || '—' }}</td>
            <td class="p-3">{{ d.chunk_count }}</td>
            <td class="p-3"><StatusBadge :status="d.indexed ? 'indexed' : 'indexing'" /></td>
            <td class="p-3 text-xs whitespace-nowrap">
              <a class="text-accent hover:underline mr-2" :href="`/api/v1/documents/${d.id}/file`" target="_blank" rel="noopener">download</a>
              <button class="text-accent hover:underline mr-2" @click="reindex(d.id)">re-index</button>
              <button class="text-danger hover:underline" @click="remove(d.id)">delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
