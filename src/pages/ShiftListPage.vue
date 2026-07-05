<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const route = useRoute()
const shifts = ref([])
const meta = ref({})
const page = ref(1)
// Allow deep-linking a filter (e.g. the dashboard "Unbilled shifts" tile).
const filter = ref(['all', 'incidents', 'unbilled'].includes(route.query.filter) ? route.query.filter : 'all')
const showArchived = ref(false)

// Search / filter / sort controls.
const search = ref('')
const clientId = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const sort = ref('date')
const clients = ref([])

// Incidents live as a sibling tab of the shift notes list, not a sidebar item.
const noteTabs = [
  { to: '/shifts', label: 'Notes' },
  { to: '/incidents', label: 'Incidents' }
]

async function load () {
  const params = { page: page.value, per_page: 20 }
  if (filter.value === 'incidents') params.incident = 'true'
  if (filter.value === 'unbilled') params.billed = 'false'
  if (showArchived.value) params.archived = 'true'
  if (search.value.trim()) params.q = search.value.trim()
  if (clientId.value) params.client_id = clientId.value
  if (dateFrom.value) params.date_from = dateFrom.value
  if (dateTo.value) params.date_to = dateTo.value
  if (sort.value !== 'date') params.sort = sort.value
  const res = await api.get('/shifts', params)
  shifts.value = res.data
  meta.value = res.meta
}

// Reset to page 1 whenever a filter changes so results start from the top.
watch([filter, showArchived, search, clientId, dateFrom, dateTo, sort], () => { page.value = 1 })
watch([page, filter, showArchived, search, clientId, dateFrom, dateTo, sort], load)

function clearFilters () {
  search.value = ''
  clientId.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  sort.value = 'date'
}

onMounted(async () => {
  load()
  // Populate the participant filter (scoped server-side to the worker's clients).
  const res = await api.get('/clients', { active: 'true', per_page: 500 })
  clients.value = res.data
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex gap-1 border-b border-white/10 overflow-x-auto">
      <router-link
        v-for="t in noteTabs"
        :key="t.to"
        :to="t.to"
        class="px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors"
        :class="route.path.startsWith(t.to) ? 'border-primary text-white' : 'border-transparent text-mid hover:text-white'"
      >{{ t.label }}</router-link>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Shift notes</h1>
      <router-link to="/shifts/new" class="btn-primary">+ New shift note</router-link>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button v-for="f in ['all', 'incidents', 'unbilled']" :key="f" class="btn-ghost text-xs" :class="filter === f ? '!bg-primary/20 !text-white' : ''" @click="filter = f">{{ f }}</button>
      <button class="btn-ghost text-xs ml-auto" :class="showArchived ? '!bg-primary/20 !text-white' : ''" @click="showArchived = !showArchived">{{ showArchived ? 'Viewing archived' : 'Show archived' }}</button>
    </div>

    <div class="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label class="text-xs text-mid space-y-1 lg:col-span-3">
        <span>Search notes</span>
        <input v-model="search" type="search" placeholder="Keywords in body, support provided, location, participant…" class="input w-full" />
      </label>
      <label class="text-xs text-mid space-y-1">
        <span>Participant</span>
        <select v-model="clientId" class="input w-full">
          <option value="">All participants</option>
          <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.display_name || c.preferred_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Client #${c.id}` }}</option>
        </select>
      </label>
      <label class="text-xs text-mid space-y-1">
        <span>From date</span>
        <input v-model="dateFrom" type="date" class="input w-full" />
      </label>
      <label class="text-xs text-mid space-y-1">
        <span>To date</span>
        <input v-model="dateTo" type="date" class="input w-full" />
      </label>
      <label class="text-xs text-mid space-y-1">
        <span>Sort by</span>
        <select v-model="sort" class="input w-full">
          <option value="date">Date (newest first)</option>
          <option value="date_asc">Date (oldest first)</option>
          <option value="client">Participant (A–Z)</option>
        </select>
      </label>
      <div class="flex items-end">
        <button class="btn-ghost text-xs" @click="clearFilters">Clear filters</button>
      </div>
    </div>

    <p v-if="!shifts.length" class="text-sm text-mid">No shift notes found.</p>
    <div class="card !p-0 overflow-x-auto" v-if="shifts.length">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-mid border-b border-white/10">
            <th class="p-3">Date</th><th class="p-3">Participant</th><th class="p-3">Hours</th><th class="p-3">Code</th><th class="p-3">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in shifts" :key="s.id" class="border-b border-white/5 hover:bg-white/5">
            <td class="p-3"><router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline">{{ s.shift_date }}</router-link></td>
            <td class="p-3">{{ s.client_display_name }}</td>
            <td class="p-3">{{ s.duration_hours || '—' }}</td>
            <td class="p-3 text-xs text-mid">{{ s.billing_code || '—' }}</td>
            <td class="p-3">
              <span class="flex flex-wrap gap-1">
                <StatusBadge :status="s.finalised ? 'finalised' : 'draft'" />
                <StatusBadge v-if="s.incident_flag" status="incident" />
                <StatusBadge v-if="s.finalised" :status="s.billed ? 'billed' : 'unbilled'" />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="meta.total_pages > 1" class="flex items-center gap-3 text-sm">
      <button class="btn-ghost" :disabled="page <= 1" @click="page--">Previous</button>
      <span class="text-mid">Page {{ meta.page }} of {{ meta.total_pages }}</span>
      <button class="btn-ghost" :disabled="page >= meta.total_pages" @click="page++">Next</button>
    </div>
  </div>
</template>
