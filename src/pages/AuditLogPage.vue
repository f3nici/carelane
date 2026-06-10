<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'

const api = useApi()

const rows = ref([])
const meta = ref({ page: 1, total: 0, total_pages: 0 })
const facets = ref({ entity_types: [], actions: [] })
const filters = ref({ entity_type: '', action: '', entity_id: '', from: '', to: '' })
const page = ref(1)
const loading = ref(false)

const actionColors = {
  created: 'text-success',
  created_manual: 'text-success',
  updated: 'text-info',
  status_changed: 'text-warning',
  ai_drafted: 'text-accent',
  finalised: 'text-success',
  deleted: 'text-danger',
  login: 'text-mid',
  login_failed: 'text-danger',
  exported: 'text-accent',
  '2fa_enabled': 'text-success',
  '2fa_disabled': 'text-warning',
  stale_warning: 'text-warning'
}

onMounted(async () => {
  const res = await api.get('/audit/facets')
  facets.value = res.data
  await load()
})

async function load () {
  loading.value = true
  try {
    const params = { page: page.value, per_page: 50 }
    for (const [k, v] of Object.entries(filters.value)) if (v) params[k] = v
    const res = await api.get('/audit', params)
    rows.value = res.data
    meta.value = res.meta
  } finally {
    loading.value = false
  }
}

function applyFilters () {
  page.value = 1
  load()
}

function reset () {
  filters.value = { entity_type: '', action: '', entity_id: '', from: '', to: '' }
  applyFilters()
}

function changePage (delta) {
  const next = page.value + delta
  if (next < 1 || next > meta.value.total_pages) return
  page.value = next
  load()
}

function parseDetails (details) {
  if (!details) return ''
  try {
    const obj = JSON.parse(details)
    const entries = Object.entries(obj)
    return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : ''
  } catch { return '' }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Audit log</h1>
      <p class="text-sm text-mid">Append-only, PII-redacted record of every action, for NDIS auditing.</p>
    </div>

    <div class="card grid sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
      <div>
        <label class="label">Entity</label>
        <select v-model="filters.entity_type" class="input">
          <option value="">All</option>
          <option v-for="t in facets.entity_types" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div>
        <label class="label">Action</label>
        <select v-model="filters.action" class="input">
          <option value="">All</option>
          <option v-for="a in facets.actions" :key="a" :value="a">{{ a }}</option>
        </select>
      </div>
      <div>
        <label class="label">Entity ID</label>
        <input v-model="filters.entity_id" class="input" inputmode="numeric" placeholder="any" />
      </div>
      <div>
        <label class="label">From</label>
        <input v-model="filters.from" type="date" class="input" />
      </div>
      <div>
        <label class="label">To</label>
        <input v-model="filters.to" type="date" class="input" />
      </div>
      <div class="flex gap-2">
        <button class="btn-primary" @click="applyFilters">Filter</button>
        <button class="btn-ghost" @click="reset">Reset</button>
      </div>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-mid border-b border-white/10">
            <th class="py-2 pr-4 font-medium">When</th>
            <th class="py-2 pr-4 font-medium">Action</th>
            <th class="py-2 pr-4 font-medium">Entity</th>
            <th class="py-2 pr-4 font-medium">User</th>
            <th class="py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="border-b border-white/5">
            <td class="py-2 pr-4 whitespace-nowrap text-mid">{{ new Date(r.created_at).toLocaleString() }}</td>
            <td class="py-2 pr-4 whitespace-nowrap font-medium" :class="actionColors[r.action] || 'text-mid'">{{ r.action }}</td>
            <td class="py-2 pr-4 whitespace-nowrap">{{ r.entity_type }}<template v-if="r.entity_id"> #{{ r.entity_id }}</template></td>
            <td class="py-2 pr-4 whitespace-nowrap">{{ r.user_name || '—' }}</td>
            <td class="py-2 text-xs text-mid">{{ parseDetails(r.details) }}</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="5" class="py-6 text-center text-mid">No matching activity.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="meta.total_pages > 1" class="flex items-center justify-between text-sm">
      <span class="text-mid">{{ meta.total }} entries · page {{ meta.page }} of {{ meta.total_pages }}</span>
      <div class="flex gap-2">
        <button class="btn-ghost" :disabled="page <= 1" @click="changePage(-1)">Previous</button>
        <button class="btn-ghost" :disabled="page >= meta.total_pages" @click="changePage(1)">Next</button>
      </div>
    </div>
  </div>
</template>
