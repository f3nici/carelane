<script setup>
import { ref, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi.js'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const shifts = ref([])
const meta = ref({})
const page = ref(1)
const filter = ref('all')

async function load () {
  const params = { page: page.value, per_page: 20 }
  if (filter.value === 'incidents') params.incident = 'true'
  if (filter.value === 'unbilled') params.billed = 'false'
  const res = await api.get('/shifts', params)
  shifts.value = res.data
  meta.value = res.meta
}

watch([page, filter], load)
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Shift notes</h1>
      <router-link to="/shifts/new" class="btn-primary">+ New shift note</router-link>
    </div>
    <div class="flex gap-2">
      <button v-for="f in ['all', 'incidents', 'unbilled']" :key="f" class="btn-ghost text-xs" :class="filter === f ? '!bg-primary/20 !text-white' : ''" @click="filter = f; page = 1">{{ f }}</button>
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
            <td class="p-3">{{ s.client_preferred_name || 'client #' + s.client_id }}</td>
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
