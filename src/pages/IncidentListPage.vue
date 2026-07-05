<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from '../stores/auth.js'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const auth = useAuthStore()
const route = useRoute()
const incidents = ref([])
const meta = ref({})
const page = ref(1)
// Allow deep-linking a filter (e.g. the dashboard incident tiles).
const filter = ref(['all', 'open', 'reportable'].includes(route.query.filter) ? route.query.filter : 'all')

// Incidents are a sibling tab of the shift notes list, not a sidebar item.
const noteTabs = [
  { to: '/shifts', label: 'Notes' },
  { to: '/incidents', label: 'Incidents' }
]

const TYPE_LABELS = {
  injury: 'Injury', illness: 'Illness/medical', medication_error: 'Medication error',
  behaviour: 'Behaviour of concern', property_damage: 'Property damage',
  abuse_neglect: 'Abuse / neglect', restrictive_practice: 'Restrictive practice',
  death: 'Death', absconding: 'Absconding / missing', other: 'Other'
}

async function load () {
  const params = { page: page.value, per_page: 20 }
  if (filter.value === 'open') params.status = 'open'
  if (filter.value === 'reportable') params.reportable = 'true'
  const res = await api.get('/incidents', params)
  incidents.value = res.data
  meta.value = res.meta
}

watch([page, filter], load)
onMounted(load)
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
      <h1 class="text-2xl font-semibold">Incident reports</h1>
      <router-link v-if="auth.isAdmin" to="/incidents/new" class="btn-primary">+ New incident report</router-link>
    </div>
    <p class="text-sm text-mid">Structured NDIS incident records with reportable-incident classification and a follow-up lifecycle. Promote a flagged shift note from the note itself, or log one directly here.</p>

    <div class="flex flex-wrap items-center gap-2">
      <button v-for="f in ['all', 'open', 'reportable']" :key="f" class="btn-ghost text-xs" :class="filter === f ? '!bg-primary/20 !text-white' : ''" @click="filter = f; page = 1">{{ f }}</button>
    </div>

    <p v-if="!incidents.length" class="text-sm text-mid">No incident reports found.</p>
    <div v-if="incidents.length" class="card !p-0 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-mid border-b border-white/10">
            <th class="p-3">Date</th><th class="p-3">Participant</th><th class="p-3">Type</th><th class="p-3">Severity</th><th class="p-3">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in incidents" :key="i.id" class="border-b border-white/5 hover:bg-white/5">
            <td class="p-3"><router-link :to="`/incidents/${i.id}`" class="text-accent hover:underline">{{ i.incident_date }}</router-link></td>
            <td class="p-3">{{ i.client_display_name }}</td>
            <td class="p-3 text-xs">{{ TYPE_LABELS[i.incident_type] || i.incident_type }}</td>
            <td class="p-3"><StatusBadge :status="i.severity" /></td>
            <td class="p-3">
              <span class="flex flex-wrap gap-1">
                <StatusBadge :status="i.status" />
                <StatusBadge v-if="i.reportable" status="reportable" />
                <span v-if="i.reportable && !i.reported_to_ndis" class="pill bg-danger/15 text-danger">unreported</span>
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
