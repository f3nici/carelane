<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import VueCal from 'vue-cal'
import 'vue-cal/dist/vuecal.css'
import { useApi } from '../composables/useApi.js'
import ScheduledShiftModal from '../components/ScheduledShiftModal.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const router = useRouter()

const events = ref([])
const clients = ref([])
const upcoming = ref([])
const active = ref(null)
const range = ref({ from: '', to: '' })

const modalOpen = ref(false)
const selectedShift = ref(null)
const selectedDate = ref('')

const STATUS_BADGE = { scheduled: 'draft', in_progress: 'active', completed: 'finalised', cancelled: 'unbilled' }

onMounted(async () => {
  const c = await api.get('/clients', { active: 'true', per_page: 100 })
  clients.value = c.data
  await loadUpcoming()
})

/** vue-cal emits the visible window (on init via `ready`, and on every change). */
async function onViewChange (e) {
  // In month view the grid spills into adjacent months — load that full range.
  range.value = { from: fmt(e.firstCellDate || e.startDate), to: fmt(e.lastCellDate || e.endDate) }
  await loadEvents()
}

const fmt = d => new Date(d).toISOString().slice(0, 10)

async function loadEvents () {
  if (!range.value.from) return
  const res = await api.get('/schedule', range.value)
  events.value = res.data.filter(s => s.status !== 'cancelled').map(toEvent)
}

async function loadUpcoming () {
  const res = await api.get('/schedule/upcoming', { days: 14 })
  upcoming.value = res.data.upcoming
  active.value = res.data.active
}

function toEvent (s) {
  const start = `${s.scheduled_date} ${s.start_time || '09:00'}`
  const end = `${s.scheduled_date} ${s.end_time || s.start_time || '10:00'}`
  return {
    start,
    end,
    title: s.client_display_name + (s.title ? ` · ${s.title}` : ''),
    class: `ev-${s.status}`,
    raw: s
  }
}

function openNew (date) {
  selectedShift.value = null
  selectedDate.value = date ? fmt(date) : new Date().toISOString().slice(0, 10)
  modalOpen.value = true
}

function openExisting (shift) {
  selectedShift.value = shift
  modalOpen.value = true
}

async function refresh () {
  await Promise.all([loadEvents(), loadUpcoming()])
}

function goWriteNote (scheduledId) {
  modalOpen.value = false
  router.push(`/shifts/new?from_schedule=${scheduledId}`)
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Roster</h1>
      <button class="btn-primary" @click="openNew()">+ Schedule shift</button>
    </div>

    <!-- Currently clocked-in banner -->
    <div v-if="active" class="card border-accent/40 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="text-sm font-medium">⏱ On shift — {{ active.client_display_name }}</p>
        <p class="text-xs text-mid">Clocked in at {{ new Date(active.clock_in_at).toLocaleTimeString() }}</p>
      </div>
      <button class="btn-primary" @click="openExisting(active)">Clock out &amp; write note</button>
    </div>

    <div class="grid lg:grid-cols-3 gap-5">
      <div class="card lg:col-span-2 !p-2">
        <vue-cal
          class="carelane-cal"
          style="height: 640px"
          :time-from="6 * 60"
          :time-to="22 * 60"
          :disable-views="['years']"
          active-view="month"
          :events="events"
          events-on-month-view="short"
          @ready="onViewChange"
          @view-change="onViewChange"
          @event-click="openExisting($event.raw)"
          @cell-click="openNew"
        />
      </div>

      <div class="card">
        <h3 class="font-semibold mb-3">Next 14 days</h3>
        <p v-if="!upcoming.length" class="text-sm text-mid">Nothing scheduled. Click a day to add a shift.</p>
        <ul class="space-y-2">
          <li v-for="s in upcoming" :key="s.id">
            <button class="w-full text-left text-sm flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5" @click="openExisting(s)">
              <span class="min-w-0">
                <span class="block truncate">{{ s.client_display_name }}</span>
                <span class="text-xs text-mid">{{ s.scheduled_date }}<template v-if="s.start_time"> · {{ s.start_time }}–{{ s.end_time || '?' }}</template></span>
              </span>
              <StatusBadge :status="STATUS_BADGE[s.status] || 'draft'" />
            </button>
          </li>
        </ul>
      </div>
    </div>

    <ScheduledShiftModal
      v-if="modalOpen"
      :shift="selectedShift"
      :clients="clients"
      :default-date="selectedDate"
      @close="modalOpen = false"
      @changed="refresh"
      @create-note="goWriteNote"
    />
  </div>
</template>

<style scoped>
/* Tint vue-cal to match the dark CareLane theme. */
.carelane-cal :deep(.vuecal__header),
.carelane-cal :deep(.vuecal__cell),
.carelane-cal :deep(.vuecal__bg) { background: transparent; color: inherit; }
.carelane-cal :deep(.vuecal__title-bar) { background: rgba(255, 255, 255, 0.04); }
.carelane-cal :deep(.vuecal__cell--today) { background: rgba(37, 99, 235, 0.12); }
.carelane-cal :deep(.vuecal__cell--selected) { background: rgba(37, 99, 235, 0.18); }
.carelane-cal :deep(.vuecal__cell--out-of-scope) { color: #666; }
.carelane-cal :deep(.vuecal__weekdays-headings),
.carelane-cal :deep(.vuecal__cell),
.carelane-cal :deep(.vuecal__time-column) { border-color: rgba(255, 255, 255, 0.08); }
.carelane-cal :deep(.vuecal__no-event) { color: #777; }
.carelane-cal :deep(.vuecal__event) { color: #fff; border-radius: 6px; padding: 1px 4px; font-size: 11px; }
.carelane-cal :deep(.ev-scheduled) { background: rgba(37, 99, 235, 0.85); }
.carelane-cal :deep(.ev-in_progress) { background: rgba(20, 184, 166, 0.9); }
.carelane-cal :deep(.ev-completed) { background: rgba(34, 197, 94, 0.7); }
</style>
