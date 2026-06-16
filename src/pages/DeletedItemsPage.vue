<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import AuditLogPage from './AuditLogPage.vue'

const api = useApi()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()

const tabs = [
  { key: 'deleted', label: 'Deleted items' },
  { key: 'audit', label: 'Audit log' }
]
const tab = ref(tabs.some(t => t.key === route.query.tab) ? route.query.tab : 'deleted')

function setTab (key) {
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
}

const items = ref([])
const loading = ref(false)
const typeFilter = ref('')
const pending = ref(null) // item awaiting restore confirmation

const TYPE_LABELS = {
  client: 'Client',
  agreement: 'Agreement',
  shift: 'Shift note',
  report: 'Report',
  template: 'Template',
  client_document: 'Document',
  goal: 'Goal',
  billing_code: 'Billing code'
}

const types = computed(() => [...new Set(items.value.map(i => i.entity_type))])
const filtered = computed(() => typeFilter.value ? items.value.filter(i => i.entity_type === typeFilter.value) : items.value)

async function load () {
  loading.value = true
  try {
    const res = await api.get('/deleted')
    items.value = res.data
  } finally {
    loading.value = false
  }
}

onMounted(load)

function confirmRestore (item) {
  pending.value = item
}

async function doRestore () {
  const item = pending.value
  pending.value = null
  if (!item) return
  try {
    await api.post(`/deleted/${item.entity_type}/${item.id}/restore`)
    toast.push(item.kind === 'deactivated' ? 'Reactivated' : 'Restored', 'success')
    await load()
  } catch {
    toast.push('Could not restore item', 'error')
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex gap-1 border-b border-white/10 overflow-x-auto">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors"
        :class="tab === t.key ? 'border-primary text-white' : 'border-transparent text-mid hover:text-white'"
        @click="setTab(t.key)"
      >{{ t.label }}</button>
    </div>

    <AuditLogPage v-if="tab === 'audit'" />

    <template v-else>
    <div>
      <h1 class="text-2xl font-semibold">Deleted items</h1>
      <p class="text-sm text-mid">Soft-deleted records are retained for NDIS compliance — nothing is ever hard-deleted. Restore anything here.</p>
    </div>

    <div v-if="types.length" class="flex flex-wrap gap-2">
      <button
        class="pill"
        :class="typeFilter === '' ? 'bg-primary/20 text-white' : 'bg-white/10 text-mid'"
        @click="typeFilter = ''"
      >All ({{ items.length }})</button>
      <button
        v-for="t in types"
        :key="t"
        class="pill"
        :class="typeFilter === t ? 'bg-primary/20 text-white' : 'bg-white/10 text-mid'"
        @click="typeFilter = t"
      >{{ TYPE_LABELS[t] || t }}</button>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-mid border-b border-white/10">
            <th class="py-2 pr-4 font-medium">Type</th>
            <th class="py-2 pr-4 font-medium">Item</th>
            <th class="py-2 pr-4 font-medium">Removed</th>
            <th class="py-2 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filtered" :key="`${item.entity_type}-${item.id}`" class="border-b border-white/5 align-top">
            <td class="py-2 pr-4 whitespace-nowrap">
              <span class="pill bg-white/10 text-mid">{{ TYPE_LABELS[item.entity_type] || item.entity_type }}</span>
            </td>
            <td class="py-2 pr-4">
              <p class="text-white">{{ item.label }}</p>
              <p v-if="item.sub_label" class="text-xs text-mid">{{ item.sub_label }}</p>
            </td>
            <td class="py-2 pr-4 whitespace-nowrap text-mid">
              <span>{{ item.removed_at ? new Date(item.removed_at).toLocaleString() : '—' }}</span>
              <span v-if="item.kind === 'deactivated'" class="ml-2 text-xs text-warning">deactivated</span>
            </td>
            <td class="py-2 text-right">
              <button class="btn-ghost" @click="confirmRestore(item)">
                {{ item.kind === 'deactivated' ? 'Reactivate' : 'Restore' }}
              </button>
            </td>
          </tr>
          <tr v-if="!filtered.length && !loading">
            <td colspan="4" class="py-6 text-center text-mid">Nothing in the recycle bin.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="!!pending"
      :title="pending && pending.kind === 'deactivated' ? 'Reactivate item?' : 'Restore item?'"
      :message="pending ? `This will bring back “${pending.label}”.` : ''"
      :confirm-label="pending && pending.kind === 'deactivated' ? 'Reactivate' : 'Restore'"
      @confirm="doRestore"
      @cancel="pending = null"
    />
    </template>
  </div>
</template>
