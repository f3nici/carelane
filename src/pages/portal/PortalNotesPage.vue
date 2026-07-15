<script setup>
import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { usePortalApi } from '../../composables/usePortalApi.js'

/** List of the participant's finalised shift notes, newest first. */
const api = usePortalApi()
const notes = ref([])
const loading = ref(true)
const page = ref(1)
const totalPages = ref(1)

/** Friendly date like "Mon 7 Jul 2026". */
function niceDate (iso) {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return iso }
}

/** Trim a note body to a short preview for the list card. */
function preview (body) {
  const text = (body || '').replace(/[#*_`>\-\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 160 ? text.slice(0, 160) + '…' : text
}

async function load () {
  loading.value = true
  try {
    const res = await api.get('/shift-notes', { page: page.value, per_page: 20 })
    notes.value = res.data
    totalPages.value = res.meta?.total_pages || 1
  } finally {
    loading.value = false
  }
}

function go (p) {
  page.value = p
  load()
  window.scrollTo({ top: 0 })
}

onMounted(load)
</script>

<template>
  <div>
    <h1 class="text-xl font-heading font-semibold mb-4">Your shift notes</h1>

    <p v-if="loading" class="text-mid text-sm">Loading…</p>
    <p v-else-if="!notes.length" class="card text-mid text-sm">
      There are no finalised shift notes to show yet. Notes appear here once your support worker completes them.
    </p>

    <ul v-else class="space-y-3">
      <li v-for="note in notes" :key="note.id">
        <RouterLink :to="{ name: 'portal-note', params: { id: note.id } }" class="card block hover:border-primary transition-colors">
          <div class="flex items-center justify-between gap-3">
            <p class="font-medium">{{ niceDate(note.shift_date) }}</p>
            <span v-if="note.incident_flag" class="pill bg-warning/15 text-warning">Incident noted</span>
          </div>
          <p v-if="note.start_time" class="text-xs text-mid mt-0.5">
            {{ note.start_time }}<span v-if="note.end_time"> – {{ note.end_time }}</span>
            <span v-if="note.location"> · {{ note.location }}</span>
          </p>
          <p v-if="preview(note.body)" class="text-sm text-mid mt-2">{{ preview(note.body) }}</p>
        </RouterLink>
      </li>
    </ul>

    <div v-if="totalPages > 1" class="flex items-center justify-center gap-3 mt-5">
      <button class="btn-ghost text-xs" :disabled="page <= 1" @click="go(page - 1)">Previous</button>
      <span class="text-xs text-mid">Page {{ page }} of {{ totalPages }}</span>
      <button class="btn-ghost text-xs" :disabled="page >= totalPages" @click="go(page + 1)">Next</button>
    </div>
  </div>
</template>
