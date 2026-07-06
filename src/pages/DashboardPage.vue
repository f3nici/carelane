<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from '../stores/auth.js'
import ActivityFeed from '../components/ActivityFeed.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const auth = useAuthStore()
const stats = ref({})
const agreementExpiries = ref([])
const documentExpiries = ref([])
const recentShifts = ref([])
const incidents = ref([])
const incidentFollowups = ref([])
const integrity = ref(null)
const upcoming = ref([])
const activeShift = ref(null)

onMounted(async () => {
  // A support worker's dashboard shows only their upcoming shifts, so that is all
  // it fetches — the operator widgets (and some of their endpoints) are admin-only.
  const sched = await api.get('/schedule/upcoming', { days: 14 })
  upcoming.value = sched.data.upcoming
  activeShift.value = sched.data.active
  if (!auth.isAdmin) return

  const [s, p, doc, sh, inc, audit, ifu] = await Promise.all([
    api.get('/dashboard/stats'),
    api.get('/dashboard/agreement-expiries'),
    api.get('/dashboard/document-expiries'),
    api.get('/shifts', { per_page: 5 }),
    api.get('/shifts', { incident: 'open', per_page: 5 }),
    api.get('/audit/verify'),
    api.get('/dashboard/incident-followups')
  ])
  stats.value = s.data
  agreementExpiries.value = p.data
  documentExpiries.value = doc.data
  recentShifts.value = sh.data
  incidents.value = inc.data
  integrity.value = audit.data
  incidentFollowups.value = ifu.data
})

// Acknowledge an expiring/expired document straight from the dashboard: it stays
// on the participant record but drops off this list (and the headline count).
async function acknowledgeDocument (d) {
  await api.put(`/clients/${d.client_id}/documents/${d.id}`, { acknowledged: 1 })
  documentExpiries.value = documentExpiries.value.filter(x => x.id !== d.id)
  if (stats.value.documents_expiring) stats.value.documents_expiring -= 1
}

const tiles = [
  { key: 'active_clients', label: 'Active clients', to: '/clients' },
  { key: 'upcoming_shifts', label: 'Upcoming shifts', to: '/roster' },
  { key: 'shifts_this_month', label: 'Shifts this month', to: '/shifts' },
  { key: 'unbilled_shifts', label: 'Unbilled shifts', to: '/shifts?filter=unbilled' },
  { key: 'agreements_expiring', label: 'Agreements expiring/review (90d)', to: '/documents?tab=agreements' },
  { key: 'documents_expiring', label: 'Consents/docs expiring (90d)' },
  { key: 'open_incident_reports', label: 'Incident reports open', danger: true, to: '/incidents?filter=open' },
  { key: 'reportable_unreported', label: 'Reportable not yet reported', danger: true, to: '/incidents?filter=reportable' }
]
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Dashboard</h1>
      <div class="flex gap-2">
        <router-link to="/roster" class="btn-primary">Roster</router-link>
        <router-link to="/shifts/new" class="btn-ghost">+ Shift note</router-link>
        <router-link v-if="auth.isAdmin" to="/clients/new" class="btn-ghost">+ Client</router-link>
      </div>
    </div>

    <router-link v-if="activeShift" to="/roster" class="card border-accent/40 flex items-center justify-between gap-3 hover:border-accent/60">
      <div>
        <p class="text-sm font-medium">⏱ On shift — {{ activeShift.client_display_name }}</p>
        <p class="text-xs text-mid">Clocked in at {{ new Date(activeShift.clock_in_at).toLocaleTimeString() }} — open the roster to clock out.</p>
      </div>
      <span class="btn-primary">Clock out</span>
    </router-link>

    <div v-if="auth.isAdmin" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <component
        :is="tile.to ? 'router-link' : 'div'"
        v-for="tile in tiles"
        :key="tile.key"
        :to="tile.to"
        class="card !p-4 block"
        :class="tile.to ? 'hover:border-white/20 transition-colors' : ''"
      >
        <p class="text-2xl font-semibold" :class="tile.danger && stats[tile.key] ? 'text-danger' : ''">{{ stats[tile.key] ?? '—' }}</p>
        <p class="text-xs text-mid mt-1">{{ tile.label }}</p>
      </component>
    </div>

    <div v-if="auth.isAdmin && incidentFollowups.length" class="card border-danger/40">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-danger">Incident reports needing follow-up</h3>
        <router-link to="/incidents" class="text-xs text-accent hover:underline">All incidents →</router-link>
      </div>
      <ul class="space-y-2">
        <li v-for="i in incidentFollowups" :key="i.id" class="text-sm flex items-center justify-between gap-2">
          <router-link :to="`/incidents/${i.id}`" class="text-accent hover:underline truncate min-w-0">{{ i.incident_date }} — {{ i.client_display_name }}</router-link>
          <span class="flex items-center gap-1 whitespace-nowrap shrink-0">
            <span v-if="i.follow_up_due_date" class="text-xs text-mid">due {{ i.follow_up_due_date }}</span>
            <StatusBadge :status="i.status" />
            <StatusBadge v-if="i.reportable && !i.reported_to_ndis" status="reportable" />
          </span>
        </li>
      </ul>
    </div>

    <div v-if="auth.isAdmin && incidents.length" class="card border-danger/40">
      <h3 class="font-semibold mb-3 text-danger">Flagged shift notes</h3>
      <ul class="space-y-2">
        <li v-for="s in incidents" :key="s.id" class="text-sm">
          <router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline">{{ s.shift_date }} — {{ s.client_display_name }}</router-link>
        </li>
      </ul>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Upcoming shifts</h3>
        <router-link to="/roster" class="text-xs text-accent hover:underline">Open roster →</router-link>
      </div>
      <p v-if="!upcoming.length" class="text-sm text-mid">Nothing scheduled in the next 14 days.</p>
      <ul class="grid sm:grid-cols-2 gap-2">
        <li v-for="s in upcoming" :key="s.id" class="text-sm flex items-center justify-between gap-2">
          <span class="truncate min-w-0">{{ s.scheduled_date }} — {{ s.client_display_name }}</span>
          <span class="text-xs text-mid whitespace-nowrap shrink-0">{{ s.start_time || '' }}<template v-if="s.status === 'in_progress'"> · on shift</template></span>
        </li>
      </ul>
    </div>

    <div v-if="auth.isAdmin" class="grid lg:grid-cols-2 gap-6">
      <div class="card" :class="documentExpiries.some(d => d.expiry_status === 'expired') ? 'border-danger/40' : ''">
        <h3 class="font-semibold mb-3">Consents &amp; documents expiring</h3>
        <p v-if="!documentExpiries.length" class="text-sm text-mid">No consent forms or documents expiring in the next 90 days.</p>
        <ul class="space-y-2">
          <li v-for="d in documentExpiries" :key="d.id" class="text-sm flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            <router-link :to="`/clients/${d.client_id}`" class="text-accent hover:underline break-words min-w-0">{{ d.client_display_name }} — {{ d.title }}</router-link>
            <span class="flex items-center gap-2 shrink-0">
              <span class="text-mid">{{ d.expiry_date }}</span>
              <StatusBadge v-if="d.expiry_status === 'expired'" status="expired" />
              <StatusBadge v-else-if="d.expiry_status === 'expiring'" status="expiring" />
              <button class="text-xs text-accent hover:underline" title="Acknowledge and hide from the dashboard" @click="acknowledgeDocument(d)">acknowledge</button>
            </span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="auth.isAdmin" class="grid lg:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Agreements expiring or due for review</h3>
        <p v-if="!agreementExpiries.length" class="text-sm text-mid">No agreements expiring or due for review in the next 90 days.</p>
        <ul class="space-y-2">
          <li v-for="a in agreementExpiries" :key="a.id" class="text-sm flex items-center justify-between gap-2">
            <router-link :to="`/agreements/${a.id}`" class="text-accent hover:underline truncate min-w-0">{{ a.client_display_name }} — {{ a.title }}</router-link>
            <span class="text-mid whitespace-nowrap shrink-0">{{ a.due_date }}<span v-if="a.due_type === 'review'" class="text-xs ml-1">(review)</span></span>
          </li>
        </ul>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Recent shifts</h3>
        <p v-if="!recentShifts.length" class="text-sm text-mid">No shift notes yet.</p>
        <ul class="space-y-2">
          <li v-for="s in recentShifts" :key="s.id" class="text-sm flex items-center justify-between gap-2">
            <router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline truncate min-w-0">{{ s.shift_date }} — {{ s.client_display_name }}</router-link>
            <StatusBadge class="shrink-0" :status="s.finalised ? 'finalised' : 'draft'" />
          </li>
        </ul>
      </div>
    </div>

    <div v-if="auth.isAdmin" class="grid lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2">
        <ActivityFeed />
      </div>
      <router-link
        v-if="integrity"
        to="/deleted?tab=audit"
        class="card flex items-start gap-3 hover:border-white/20 transition-colors"
        :class="integrity.valid ? '' : 'border-danger/40'"
      >
        <div :class="['p-2 rounded-lg shrink-0', integrity.valid ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger']">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path v-if="integrity.valid" stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
          </svg>
        </div>
        <div class="min-w-0">
          <h3 class="font-semibold" :class="integrity.valid ? '' : 'text-danger'">Audit log integrity</h3>
          <p class="text-sm mt-1" :class="integrity.valid ? 'text-success' : 'text-danger'">
            {{ integrity.valid ? 'Chain verified' : 'Tampering detected' }}
          </p>
          <p class="text-xs text-mid mt-1">{{ integrity.verified }} of {{ integrity.total }} entries hash-chained.</p>
        </div>
      </router-link>
    </div>
  </div>
</template>
