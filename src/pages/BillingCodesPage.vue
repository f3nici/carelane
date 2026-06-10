<script setup>
import { ref, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import BillingCodeImport from '../components/BillingCodeImport.vue'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const toast = useToastStore()
const codes = ref([])
const meta = ref({})
const page = ref(1)
const q = ref('')
const showImport = ref(false)
const editing = ref(null)
let debounce = null

async function load () {
  const res = await api.get('/billing-codes', { page: page.value, per_page: 50, q: q.value || undefined })
  codes.value = res.data
  meta.value = res.meta
}

watch(q, () => { clearTimeout(debounce); debounce = setTimeout(() => { page.value = 1; load() }, 300) })
watch(page, load)
onMounted(load)

function startNew () {
  editing.value = { code: '', name: '', support_category: '', unit: 'H', price_cap_standard: null, quote_required: 0, active: 1 }
}

async function saveEditing () {
  const e = editing.value
  const payload = {
    code: e.code,
    name: e.name,
    support_category: e.support_category || null,
    unit: e.unit,
    price_cap_standard: e.price_cap_standard !== null && e.price_cap_standard !== '' ? Number(e.price_cap_standard) : null,
    quote_required: e.quote_required ? 1 : 0,
    active: e.active ? 1 : 0
  }
  if (e.id) await api.put(`/billing-codes/${e.id}`, payload)
  else await api.post('/billing-codes', payload)
  toast.push('Support item saved', 'success')
  editing.value = null
  load()
}

async function deactivate (id) {
  await api.del(`/billing-codes/${id}`)
  toast.push('Item deactivated (history kept for past claims)', 'success')
  load()
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Billing codes</h1>
      <div class="flex gap-2">
        <button class="btn-ghost" @click="showImport = !showImport">{{ showImport ? 'Hide import' : 'Import price guide' }}</button>
        <button class="btn-primary" @click="startNew">+ Add item</button>
      </div>
    </div>

    <BillingCodeImport v-if="showImport" @imported="load" />

    <div v-if="editing" class="card space-y-3">
      <h3 class="font-semibold">{{ editing.id ? 'Edit' : 'New' }} support item</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div><label class="label">Code</label><input v-model="editing.code" class="input font-mono" /></div>
        <div class="lg:col-span-2"><label class="label">Name</label><input v-model="editing.name" class="input" /></div>
        <div><label class="label">Category</label><input v-model="editing.support_category" class="input" /></div>
        <div>
          <label class="label">Unit</label>
          <select v-model="editing.unit" class="input"><option v-for="u in ['H', 'E', 'D', 'WK', 'MON']" :key="u" :value="u">{{ u }}</option></select>
        </div>
        <div><label class="label">Price cap (standard)</label><input v-model="editing.price_cap_standard" type="number" step="0.01" class="input" /></div>
        <label class="flex items-center gap-2 text-sm self-end pb-2"><input v-model="editing.quote_required" type="checkbox" :true-value="1" :false-value="0" class="accent-primary" /> Quote required</label>
        <label class="flex items-center gap-2 text-sm self-end pb-2"><input v-model="editing.active" type="checkbox" :true-value="1" :false-value="0" class="accent-success" /> Active</label>
      </div>
      <div class="flex gap-2">
        <button class="btn-primary" @click="saveEditing">Save</button>
        <button class="btn-ghost" @click="editing = null">Cancel</button>
      </div>
    </div>

    <input v-model="q" class="input max-w-md" placeholder="Search code, name or category…" />

    <div class="card !p-0 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-mid border-b border-white/10">
            <th class="p-3">Code</th><th class="p-3">Name</th><th class="p-3">Unit</th><th class="p-3">Cap (std)</th><th class="p-3">Guide</th><th class="p-3">Status</th><th class="p-3"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in codes" :key="c.id" class="border-b border-white/5 hover:bg-white/5">
            <td class="p-3 font-mono text-xs">{{ c.code }}</td>
            <td class="p-3">{{ c.name }}</td>
            <td class="p-3">{{ c.unit }}</td>
            <td class="p-3">{{ c.quote_required ? 'quote' : (c.price_cap_standard != null ? `$${c.price_cap_standard.toFixed(2)}` : '—') }}</td>
            <td class="p-3 text-xs text-mid">{{ c.price_guide_version || '—' }}</td>
            <td class="p-3"><StatusBadge :status="c.active ? 'active' : 'expired'" /></td>
            <td class="p-3 text-xs whitespace-nowrap">
              <button class="text-accent hover:underline mr-2" @click="editing = { ...c }">edit</button>
              <button v-if="c.active" class="text-danger hover:underline" @click="deactivate(c.id)">deactivate</button>
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
