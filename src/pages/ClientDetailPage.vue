<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import StatusBadge from '../components/StatusBadge.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ClientGoals from '../components/ClientGoals.vue'
import ClientDocuments from '../components/ClientDocuments.vue'

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
const goalCount = ref(0)
const documentCount = ref(0)
const confirmDelete = ref(false)
const tab = ref('overview')

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

/** Persist the per-participant rates after editing a custom rate inline. */
async function saveRates () {
  const codes = billingCodes.value.map(c => ({
    billing_code_id: c.id,
    custom_rate: c.custom_rate === '' || c.custom_rate == null ? null : Number(c.custom_rate)
  }))
  const res = await api.put(`/clients/${id}/billing-codes`, { codes })
  billingCodes.value = res.data
  toast.push('Rates saved', 'success')
}

async function remove () {
  await api.del(`/clients/${id}`)
  toast.push('Client archived (soft-deleted for record retention)', 'success')
  router.push('/clients')
}

/** Download everything held for this participant as a zip (PDF summary + JSON). */
function exportData () {
  window.open(`/api/v1/clients/${id}/export.zip`, '_blank')
}

const tabs = [
  { key: 'overview', label: 'Overview' },
  { key: 'goals', label: 'Goals', count: goalCount },
  { key: 'documents', label: 'Documents & consents', count: documentCount }
]
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

    <div class="flex gap-1 border-b border-white/10">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
        :class="tab === t.key ? 'border-accent text-white' : 'border-transparent text-mid hover:text-white'"
        @click="tab = t.key"
      >{{ t.label }}<span v-if="t.count && t.count.value" class="ml-1 text-mid">({{ t.count.value }})</span></button>
    </div>

    <div v-show="tab === 'overview'" class="space-y-6">
    <div class="grid md:grid-cols-3 gap-4">
      <div class="card">
        <h3 class="font-semibold mb-3">Plan</h3>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between"><dt class="text-mid">Management</dt><dd>{{ client.plan_management_type || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Plan manager</dt><dd>{{ client.plan_manager_name || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-mid">Invoice due</dt><dd>{{ (client.invoice_due_days ?? 45) }} days</dd></div>
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
        <p class="text-sm">
          Tracked goals live in the <button class="text-accent hover:underline" @click="tab = 'goals'">Goals tab</button>.
        </p>
        <p v-if="client.support_goals" class="text-xs text-mid mt-2 whitespace-pre-wrap">Notes: {{ client.support_goals }}</p>
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
      <p class="text-xs text-mid mb-2">Set the rate you charge this participant for each item — this is the rate used when generating a Square invoice. Leave blank to use the NDIS price-cap (<span class="italic">standard</span>).</p>
      <ul class="space-y-2">
        <li v-for="c in billingCodes" :key="c.id" class="text-sm flex items-center justify-between gap-3">
          <span class="truncate min-w-0">{{ c.code }} — {{ c.name }}</span>
          <span class="flex items-center gap-2 shrink-0">
            <span class="text-mid">$</span>
            <input
              v-model="c.custom_rate"
              type="number"
              step="0.01"
              min="0"
              class="input w-24 text-right py-1"
              :placeholder="c.price_cap_standard ?? '—'"
              @change="saveRates"
            />
            <span class="text-mid">/{{ c.unit }}</span>
            <button class="text-danger text-xs hover:underline" @click="removeCode(c.id)">remove</button>
          </span>
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
    </div>

    <div v-show="tab === 'goals'">
      <ClientGoals :client-id="id" @count="goalCount = $event" />
    </div>

    <div v-show="tab === 'documents'">
      <ClientDocuments :client-id="id" @count="documentCount = $event" />
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
