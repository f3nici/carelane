<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useActivityFormat } from '../composables/useActivityFormat.js'

const api = useApi()
const { parseDetails, humanizeField, formatValue, changesOf, extraDetails, actionColors } = useActivityFormat()

const rows = ref([])
const meta = ref({ page: 1, total: 0, total_pages: 0 })
const facets = ref({ entity_types: [], actions: [] })
const filters = ref({ entity_type: '', action: '', entity_id: '', from: '', to: '' })
const page = ref(1)
const loading = ref(false)
const integrity = ref(null)

onMounted(async () => {
  const [f, v] = await Promise.all([api.get('/audit/facets'), api.get('/audit/verify')])
  facets.value = f.data
  integrity.value = v.data
  await load()
})

async function load () {
  loading.value = true
  try {
    const params = { page: page.value, per_page: 50 }
    for (const [k, v] of Object.entries(filters.value)) if (v) params[k] = v
    const res = await api.get('/audit', params)
    rows.value = res.data.map(r => ({ ...r, parsed: parseDetails(r.details) }))
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
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Audit log</h1>
      <p class="text-sm text-mid">Append-only, PII-redacted record of every action, for NDIS auditing.</p>
    </div>

    <!-- Tamper-evident hash-chain integrity -->
    <div v-if="integrity" class="card flex items-start gap-3" :class="integrity.valid ? '' : 'border-danger/40'">
      <div :class="['p-2 rounded-lg shrink-0', integrity.valid ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger']">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path v-if="integrity.valid" stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
        </svg>
      </div>
      <div class="min-w-0">
        <p class="font-semibold" :class="integrity.valid ? 'text-success' : 'text-danger'">
          {{ integrity.valid ? 'Chain verified' : 'Tampering detected' }}
        </p>
        <p class="text-xs text-mid mt-0.5">{{ integrity.verified }} of {{ integrity.total }} entries hash-chained.</p>
        <p v-if="!integrity.valid" class="text-xs text-danger mt-0.5">Chain breaks at entry #{{ integrity.broken_at }}.</p>
      </div>
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
          <tr v-for="r in rows" :key="r.id" class="border-b border-white/5 align-top">
            <td class="py-2 pr-4 whitespace-nowrap text-mid">{{ new Date(r.created_at).toLocaleString() }}</td>
            <td class="py-2 pr-4 whitespace-nowrap font-medium" :class="actionColors[r.action] || 'text-mid'">{{ r.action }}</td>
            <td class="py-2 pr-4 whitespace-nowrap">{{ r.entity_type }}<template v-if="r.entity_id"> #{{ r.entity_id }}</template></td>
            <td class="py-2 pr-4 whitespace-nowrap">{{ r.user_name || '—' }}</td>
            <td class="py-2 text-xs text-mid">
              <ul v-if="changesOf(r.parsed).length" class="space-y-0.5">
                <li v-for="c in changesOf(r.parsed)" :key="c.field">
                  <span class="text-white/80">{{ humanizeField(c.field) }}:</span>
                  <span class="line-through opacity-60">{{ formatValue(c.from) }}</span>
                  <span class="mx-1">→</span>
                  <span class="text-white">{{ formatValue(c.to) }}</span>
                </li>
              </ul>
              <span v-else>{{ extraDetails(r.parsed) }}</span>
            </td>
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
