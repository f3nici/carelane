<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import StatusBadge from '../components/StatusBadge.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const id = route.params.id

const client = ref(null)
const agreements = ref([])
const shifts = ref([])
const billingCodes = ref([])
const allCodes = ref([])
const confirmDelete = ref(false)

onMounted(async () => {
  const [c, a, s, b, all] = await Promise.all([
    api.get(`/clients/${id}`),
    api.get(`/clients/${id}/agreements`, { per_page: 10 }),
    api.get(`/clients/${id}/shifts`, { per_page: 10 }),
    api.get(`/clients/${id}/billing-codes`),
    api.get('/billing-codes', { active: 'true', per_page: 100 })
  ])
  client.value = c.data
  agreements.value = a.data
  shifts.value = s.data
  billingCodes.value = b.data
  allCodes.value = all.data
})

async function addCode (event) {
  const codeId = Number(event.target.value)
  if (!codeId) return
  event.target.value = ''
  const codes = [...billingCodes.value.map(c => ({ billing_code_id: c.id, custom_rate: c.custom_rate })), { billing_code_id: codeId }]
  const res = await api.put(`/clients/${id}/billing-codes`, { codes })
  billingCodes.value = res.data
}

async function removeCode (codeId) {
  const codes = billingCodes.value.filter(c => c.id !== codeId).map(c => ({ billing_code_id: c.id, custom_rate: c.custom_rate }))
  const res = await api.put(`/clients/${id}/billing-codes`, { codes })
  billingCodes.value = res.data
}

async function remove () {
  await api.del(`/clients/${id}`)
  toast.push('Client archived (soft-deleted for record retention)', 'success')
  router.push('/clients')
}

async function exportData () {
  const res = await api.get(`/clients/${id}/export`)
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `client-${id}-export.json`
  a.click()
}
</script>

<template>
  <div v-if="client" class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ client.preferred_name || `${client.first_name} ${client.last_name}` }}</h1>
        <p class="text-sm text-mid">{{ client.first_name }} {{ client.last_name }} · NDIS {{ client.ndis_number || '—' }}</p>
      </div>
      <div class="flex gap-2">
        <router-link :to="`/shifts/new?client=${id}`" class="btn-primary">+ Shift note</router-link>
        <router-link :to="`/clients/${id}/edit`" class="btn-ghost">Edit</router-link>
        <button class="btn-ghost" @click="exportData">Export data</button>
        <button class="btn-danger" @click="confirmDelete = true">Archive</button>
      </div>
    </div>

    <div class="grid md:grid-cols-3 gap-4">
      <div class="card">
        <h3 class="font-semibold mb-3">Plan</h3>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between"><dt class="text-mid">Plan period</dt><dd>{{ client.plan_start || '—' }} → {{ client.plan_end || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Management</dt><dd>{{ client.plan_management_type || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Plan manager</dt><dd>{{ client.plan_manager_name || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Disability</dt><dd>{{ client.primary_disability || '—' }}</dd></div>
        </dl>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Contact</h3>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between"><dt class="text-mid">Phone</dt><dd>{{ client.phone || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Email</dt><dd class="truncate">{{ client.email || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Address</dt><dd class="text-right">{{ [client.address, client.suburb, client.state, client.postcode].filter(Boolean).join(', ') || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Emergency</dt><dd>{{ client.emergency_contact_name || '—' }} {{ client.emergency_contact_phone }}</dd></div>
        </dl>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Goals & communication</h3>
        <p class="text-sm whitespace-pre-wrap">{{ client.support_goals || 'No goals recorded.' }}</p>
        <p v-if="client.communication_needs" class="text-xs text-mid mt-2 whitespace-pre-wrap">Communication: {{ client.communication_needs }}</p>
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Billing codes</h3>
        <select class="input max-w-xs" @change="addCode">
          <option value="">+ Add a support item…</option>
          <option v-for="c in allCodes.filter(c => !billingCodes.some(b => b.id === c.id))" :key="c.id" :value="c.id">{{ c.code }} — {{ c.name }}</option>
        </select>
      </div>
      <p v-if="!billingCodes.length" class="text-sm text-mid">No support items linked yet.</p>
      <ul class="space-y-2">
        <li v-for="c in billingCodes" :key="c.id" class="text-sm flex items-center justify-between gap-2">
          <span class="truncate">{{ c.code }} — {{ c.name }} <span class="text-mid">(${{ c.custom_rate ?? c.price_cap_standard }}/{{ c.unit }})</span></span>
          <button class="text-danger text-xs hover:underline shrink-0" @click="removeCode(c.id)">remove</button>
        </li>
      </ul>
    </div>

    <div class="grid lg:grid-cols-2 gap-6">
      <div class="card">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold">Agreements</h3>
          <router-link :to="`/agreements/new?client=${id}`" class="text-accent text-sm hover:underline">+ New</router-link>
        </div>
        <p v-if="!agreements.length" class="text-sm text-mid">No agreements yet.</p>
        <ul class="space-y-2">
          <li v-for="a in agreements" :key="a.id" class="text-sm flex items-center justify-between gap-2">
            <router-link :to="`/agreements/${a.id}`" class="text-accent hover:underline truncate">{{ a.title }}</router-link>
            <StatusBadge :status="a.status" />
          </li>
        </ul>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Recent shifts</h3>
        <p v-if="!shifts.length" class="text-sm text-mid">No shift notes yet.</p>
        <ul class="space-y-2">
          <li v-for="s in shifts" :key="s.id" class="text-sm flex items-center justify-between gap-2">
            <router-link :to="`/shifts/${s.id}`" class="text-accent hover:underline">{{ s.shift_date }} ({{ s.duration_hours || '?' }}h)</router-link>
            <span class="flex gap-1">
              <StatusBadge v-if="s.incident_flag" status="incident" />
              <StatusBadge :status="s.billed ? 'billed' : 'unbilled'" />
            </span>
          </li>
        </ul>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmDelete"
      title="Archive this client?"
      message="The record is soft-deleted and retained per NDIS record-keeping obligations. It will no longer appear in lists."
      confirm-label="Archive"
      danger
      @confirm="remove"
      @cancel="confirmDelete = false"
    />
  </div>
</template>
