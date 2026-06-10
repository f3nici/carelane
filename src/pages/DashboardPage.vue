<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import ActivityFeed from '../components/ActivityFeed.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const stats = ref({})
const planReviews = ref([])
const recentShifts = ref([])
const incidents = ref([])

onMounted(async () => {
  const [s, p, sh, inc] = await Promise.all([
    api.get('/dashboard/stats'),
    api.get('/dashboard/plan-reviews'),
    api.get('/shifts', { per_page: 5 }),
    api.get('/shifts', { incident: 'true', per_page: 5 })
  ])
  stats.value = s.data
  planReviews.value = p.data
  recentShifts.value = sh.data
  incidents.value = inc.data
})

const tiles = [
  { key: 'active_clients', label: 'Active clients' },
  { key: 'agreements_active', label: 'Active agreements' },
  { key: 'shifts_this_month', label: 'Shifts this month' },
  { key: 'unbilled_shifts', label: 'Unbilled shifts' },
  { key: 'plan_reviews_due', label: 'Plan reviews due (60d)' },
  { key: 'open_incidents', label: 'Incidents needing follow-up' }
]
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Dashboard</h1>
      <div class="flex gap-2">
        <router-link to="/shifts/new" class="btn-primary">+ Shift note</router-link>
        <router-link to="/clients/new" class="btn-ghost">+ Client</router-link>
      </div>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <div v-for="tile in tiles" :key="tile.key" class="card !p-4">
        <p class="text-2xl font-semibold" :class="tile.key === 'open_incidents' && stats[tile.key] ? 'text-danger' : ''">{{ stats[tile.key] ?? '—' }}</p>
        <p class="text-xs text-mid mt-1">{{ tile.label }}</p>
      </div>
    </div>

    <div v-if="incidents.length" class="card border-danger/40">
      <h3 class="font-semibold mb-3 text-danger">Flagged incidents</h3>
      <ul class="space-y-2">
        <li v-for="s in incidents" :key="s.id" class="text-sm">
          <router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline">{{ s.shift_date }} — {{ s.client_preferred_name || 'client #' + s.client_id }}</router-link>
        </li>
      </ul>
    </div>

    <div class="grid lg:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Upcoming plan reviews</h3>
        <p v-if="!planReviews.length" class="text-sm text-mid">Nothing due in the next 60 days.</p>
        <ul class="space-y-2">
          <li v-for="c in planReviews" :key="c.id" class="text-sm flex justify-between">
            <router-link :to="`/clients/${c.id}`" class="text-accent hover:underline">{{ c.preferred_name || 'Client #' + c.id }}</router-link>
            <span class="text-mid">{{ c.plan_end }}</span>
          </li>
        </ul>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Recent shifts</h3>
        <p v-if="!recentShifts.length" class="text-sm text-mid">No shift notes yet.</p>
        <ul class="space-y-2">
          <li v-for="s in recentShifts" :key="s.id" class="text-sm flex items-center justify-between gap-2">
            <router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline truncate">{{ s.shift_date }} — {{ s.client_preferred_name || 'client #' + s.client_id }}</router-link>
            <StatusBadge :status="s.finalised ? 'finalised' : 'draft'" />
          </li>
        </ul>
      </div>
    </div>

    <ActivityFeed />
  </div>
</template>
