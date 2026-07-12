<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { usePortalApi } from '../../composables/usePortalApi.js'
import { renderMarkdown } from '../../composables/useMarkdown.js'

/** A single finalised shift note, with the narrative rendered from Markdown. */
const api = usePortalApi()
const route = useRoute()
const note = ref(null)
const loading = ref(true)

const bodyHtml = computed(() => renderMarkdown(note.value?.body || ''))
const incidentHtml = computed(() => renderMarkdown(note.value?.incident_details || ''))

function niceDate (iso) {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  } catch { return iso }
}

/** Same-origin, cookie-authenticated URL for a note photo. */
function photoUrl (photoId) {
  return `/api/v1/portal/shift-notes/${route.params.id}/photos/${photoId}/file`
}

onMounted(async () => {
  try {
    note.value = await api.get(`/shift-notes/${route.params.id}`)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div>
    <RouterLink :to="{ name: 'portal-notes' }" class="text-sm text-mid hover:text-white">← Back to shift notes</RouterLink>

    <p v-if="loading" class="text-mid text-sm mt-4">Loading…</p>
    <p v-else-if="!note" class="card text-mid text-sm mt-4">This shift note could not be found.</p>

    <article v-else class="mt-4 space-y-5">
      <header>
        <h1 class="text-xl font-heading font-semibold">{{ niceDate(note.shift_date) }}</h1>
        <p class="text-sm text-mid mt-1">
          <span v-if="note.start_time">{{ note.start_time }}<span v-if="note.end_time"> – {{ note.end_time }}</span></span>
          <span v-if="note.duration_hours"> · {{ note.duration_hours }} h</span>
          <span v-if="note.location"> · {{ note.location }}</span>
        </p>
        <span v-if="note.incident_flag" class="pill bg-warning/15 text-warning mt-2">Incident noted during this shift</span>
      </header>

      <section v-if="note.support_provided" class="card">
        <p class="label">Support provided</p>
        <p class="text-sm">{{ note.support_provided }}</p>
      </section>

      <section v-if="note.body" class="card">
        <p class="label">Shift note</p>
        <div class="prose-portal" v-html="bodyHtml"></div>
      </section>

      <section v-if="note.incident_details" class="card border-warning/40 bg-warning/5">
        <p class="label text-warning">Incident details</p>
        <div class="prose-portal" v-html="incidentHtml"></div>
      </section>

      <section v-if="note.participant_response" class="card">
        <p class="label">How the shift went</p>
        <p class="text-sm">{{ note.participant_response }}</p>
      </section>

      <section v-if="note.photos?.length" class="card">
        <p class="label">Photos</p>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <figure v-for="photo in note.photos" :key="photo.id" class="space-y-1">
            <img :src="photoUrl(photo.id)" :alt="photo.caption || 'Shift photo'" class="rounded-lg w-full h-32 object-cover border border-white/10" loading="lazy" />
            <figcaption v-if="photo.caption" class="text-xs text-mid">{{ photo.caption }}</figcaption>
          </figure>
        </div>
      </section>
    </article>
  </div>
</template>

<style scoped>
/* Light-touch typography for the rendered Markdown note body. */
.prose-portal :deep(p) { @apply text-sm mb-3 leading-relaxed; }
.prose-portal :deep(h1),
.prose-portal :deep(h2),
.prose-portal :deep(h3) { @apply font-heading font-semibold mt-4 mb-2; }
.prose-portal :deep(ul) { @apply list-disc pl-5 text-sm mb-3 space-y-1; }
.prose-portal :deep(ol) { @apply list-decimal pl-5 text-sm mb-3 space-y-1; }
.prose-portal :deep(a) { @apply text-primary underline; }
.prose-portal :deep(strong) { @apply font-semibold; }
</style>
