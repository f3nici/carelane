<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useIntegrations } from '../composables/useIntegrations.js'
import { renderMarkdown } from '../composables/useMarkdown.js'

const api = useApi()
const { aiActive, ensureLoaded } = useIntegrations()
const q = ref('')
const mode = ref('search')
const results = ref([])
const answer = ref('')
const sources = ref([])
const busy = ref(false)

onMounted(ensureLoaded)

async function run () {
  if (!q.value.trim()) return
  busy.value = true
  answer.value = ''
  results.value = []
  sources.value = []
  try {
    if (mode.value === 'ask') {
      const res = await api.post('/documents/ask', { question: q.value })
      answer.value = res.data.answer
      sources.value = res.data.sources
    } else {
      const res = await api.get('/documents/search', { q: q.value })
      results.value = res.data.results
    }
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card space-y-4">
    <div class="flex gap-2">
      <button class="btn-ghost text-xs" :class="mode === 'search' ? '!bg-primary/20 !text-white' : ''" @click="mode = 'search'">Search (local)</button>
      <button v-if="aiActive" class="btn-ghost text-xs" :class="mode === 'ask' ? '!bg-primary/20 !text-white' : ''" @click="mode = 'ask'">Ask (Claude, grounded)</button>
    </div>
    <form class="flex gap-2" @submit.prevent="run">
      <input v-model="q" class="input" :placeholder="mode === 'ask' ? 'Ask a question about your NDIS documents…' : 'Search guidelines and policies…'" />
      <button class="btn-primary shrink-0" :disabled="busy">{{ busy ? 'Working…' : (mode === 'ask' ? 'Ask' : 'Search') }}</button>
    </form>
    <p v-if="mode === 'ask'" class="text-xs text-mid">Only the top matching excerpts are sent to Claude; answers cite document and page.</p>

    <div v-if="answer" class="space-y-3">
      <div class="text-sm space-y-2" v-html="renderMarkdown(answer)" />
      <div v-if="sources.length">
        <h4 class="text-xs font-semibold text-mid uppercase mb-1">Sources</h4>
        <ul class="space-y-1 text-xs text-mid">
          <li v-for="(s, i) in sources" :key="i">
            <span class="text-accent">{{ s.title }}</span>, p.{{ s.page }} — {{ s.snippet }}…
            <a v-if="s.document_id" class="text-accent hover:underline ml-1" :href="`/api/v1/documents/${s.document_id}/file`" target="_blank" rel="noopener">(download)</a>
          </li>
        </ul>
      </div>
    </div>

    <ul v-if="results.length" class="space-y-3">
      <li v-for="(r, i) in results" :key="i" class="text-sm border-b border-white/5 pb-2">
        <p class="text-xs mb-1">
          <span class="text-accent">{{ r.title }} · page {{ r.page }}</span><span v-if="r.score" class="text-mid"> · {{ (r.score * 100).toFixed(0) }}% match</span>
          <a class="text-accent hover:underline ml-1" :href="`/api/v1/documents/${r.document_id}/file`" target="_blank" rel="noopener">(download)</a>
        </p>
        <p class="text-mid">{{ r.content.slice(0, 350) }}…</p>
      </li>
    </ul>
  </div>
</template>
