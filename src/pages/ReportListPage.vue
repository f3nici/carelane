<script setup>
import { ref, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from '../stores/auth.js'
import StatusBadge from '../components/StatusBadge.vue'

const api = useApi()
const auth = useAuthStore()
const reports = ref([])
const meta = ref({})
const page = ref(1)
const showArchived = ref(false)

async function load () {
  const res = await api.get('/reports', { page: page.value, per_page: 20, archived: showArchived.value ? 'true' : undefined })
  reports.value = res.data
  meta.value = res.meta
}

watch([page, showArchived], load)
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Reports</h1>
      <div class="flex items-center gap-2">
        <button class="btn-ghost text-xs" :class="showArchived ? '!bg-primary/20 !text-white' : ''" @click="showArchived = !showArchived; page = 1">{{ showArchived ? 'Viewing archived' : 'Show archived' }}</button>
        <router-link v-if="auth.isAdmin" to="/reports/new" class="btn-primary">+ New report</router-link>
      </div>
    </div>
    <p v-if="!reports.length" class="text-sm text-mid">No reports yet.</p>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <router-link v-for="r in reports" :key="r.id" :to="`/reports/${r.id}`" class="card block hover:border-primary/50 transition-colors">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-semibold capitalize">{{ r.report_type.replace('_', ' ') }}</h3>
          <StatusBadge :status="r.status" />
        </div>
        <p class="text-xs text-mid mt-1">{{ r.client_display_name }}</p>
        <p class="text-xs text-mid mt-2">{{ r.period_start || '—' }} → {{ r.period_end || '—' }}</p>
      </router-link>
    </div>
    <div v-if="meta.total_pages > 1" class="flex items-center gap-3 text-sm">
      <button class="btn-ghost" :disabled="page <= 1" @click="page--">Previous</button>
      <span class="text-mid">Page {{ meta.page }} of {{ meta.total_pages }}</span>
      <button class="btn-ghost" :disabled="page >= meta.total_pages" @click="page++">Next</button>
    </div>
  </div>
</template>
