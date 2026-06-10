<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'

const api = useApi()
const items = ref([])

const actionColors = {
  created: 'text-success',
  updated: 'text-info',
  status_changed: 'text-warning',
  ai_drafted: 'text-accent',
  finalised: 'text-success',
  deleted: 'text-danger'
}

onMounted(async () => {
  const res = await api.get('/dashboard/activity', { limit: 20 })
  items.value = res.data
})
</script>

<template>
  <div class="card">
    <h3 class="font-semibold mb-3">Recent activity</h3>
    <p v-if="!items.length" class="text-sm text-mid">No activity yet.</p>
    <ul class="space-y-2 max-h-96 overflow-y-auto">
      <li v-for="item in items" :key="item.id" class="text-sm flex items-baseline gap-2">
        <span class="font-medium shrink-0" :class="actionColors[item.action] || 'text-mid'">{{ item.action }}</span>
        <span class="text-white">{{ item.entity_type }}<template v-if="item.entity_id"> #{{ item.entity_id }}</template></span>
        <span class="text-xs text-mid ml-auto shrink-0">{{ new Date(item.created_at).toLocaleString() }}</span>
      </li>
    </ul>
  </div>
</template>
