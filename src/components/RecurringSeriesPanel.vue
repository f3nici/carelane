<script setup>
import { ref, onMounted, computed } from 'vue'
import { useApi } from '../composables/useApi.js'
import RecurringSeriesModal from './RecurringSeriesModal.vue'

// Every repeating appointment in one place. The calendar shows the individual
// occurrences a series produced; this is where the series itself is edited or
// stopped, so a standing weekly shift doesn't have to be changed (or cleared)
// one day at a time. Admin-only, like the rest of roster planning.

const props = defineProps({
  clients: { type: Array, default: () => [] },
  workers: { type: Array, default: () => [] }
})
const emit = defineEmits(['changed'])

const api = useApi()
const series = ref([])
const loading = ref(true)
const editingId = ref(null)
const expanded = ref(false)

const FREQUENCY_LABEL = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const visible = computed(() => (expanded.value ? series.value : series.value.slice(0, 4)))

onMounted(load)

async function load () {
  loading.value = true
  try {
    const res = await api.get('/schedule/recurrences')
    series.value = res.data
  } catch { /* toast via interceptor */ } finally { loading.value = false }
}

/** "Every week on Mon, Thu · 09:00–11:00" */
function summary (s) {
  const every = s.interval > 1 ? `Every ${s.interval} ${FREQUENCY_LABEL[s.frequency]}s` : `Every ${FREQUENCY_LABEL[s.frequency]}`
  const days = s.weekdays?.length ? ` on ${s.weekdays.map(d => DAY_LABEL[d]).join(', ')}` : ''
  const time = s.start_time ? ` · ${s.start_time}–${s.end_time || '?'}` : ''
  return `${every}${days}${time}`
}

/** A series is "running" only while it is active and not past its end date. */
function running (s) {
  return !!s.active && (!s.until_date || s.until_date >= new Date().toISOString().slice(0, 10))
}

async function onChanged () {
  await load()
  emit('changed')
}
</script>

<template>
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h3 class="font-semibold">Repeating appointments</h3>
      <button v-if="series.length > 4" class="text-xs text-mid hover:text-white" @click="expanded = !expanded">
        {{ expanded ? 'Show fewer' : `Show all ${series.length}` }}
      </button>
    </div>

    <p v-if="loading" class="text-sm text-mid">Loading…</p>
    <p v-else-if="!series.length" class="text-sm text-mid">
      No repeating appointments yet. Tick “Repeat this appointment” when you schedule a shift to create one.
    </p>

    <ul v-else class="space-y-2">
      <li v-for="s in visible" :key="s.id">
        <button class="w-full text-left rounded-lg border border-white/10 px-3 py-2 hover:bg-white/5" @click="editingId = s.id">
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-sm">{{ s.client_display_name }}</span>
            <span v-if="s.title" class="text-xs text-mid truncate">{{ s.title }}</span>
            <span class="pill ml-auto" :class="running(s) ? 'bg-accent/20 text-accent' : 'bg-white/10 text-mid'">
              {{ running(s) ? 'Running' : 'Ended' }}
            </span>
          </span>
          <span class="block text-xs text-mid mt-0.5">{{ summary(s) }}</span>
          <span class="block text-xs text-mid">
            {{ s.upcoming_count }} upcoming<template v-if="s.next_date"> · next {{ s.next_date }}</template>
            <template v-if="s.until_date"> · until {{ s.until_date }}</template>
            <template v-else> · no end date</template>
            <template v-if="s.worker_display_name"> · {{ s.worker_display_name }}</template>
          </span>
        </button>
      </li>
    </ul>

    <RecurringSeriesModal
      v-if="editingId"
      :series-id="editingId"
      :clients="props.clients"
      :workers="props.workers"
      @close="editingId = null"
      @changed="onChanged"
    />
  </div>
</template>
