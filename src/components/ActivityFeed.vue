<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useActivityFormat } from '../composables/useActivityFormat.js'

const api = useApi()
const items = ref([])
const { parseDetails, humanizeField, formatValue, changesOf, extraDetails, actionColors } = useActivityFormat()

onMounted(async () => {
  const res = await api.get('/dashboard/activity', { limit: 20 })
  items.value = res.data.map(i => ({ ...i, parsed: parseDetails(i.details) }))
})
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold">Recent activity</h3>
      <router-link to="/audit" class="text-xs text-accent hover:underline">View all</router-link>
    </div>
    <p v-if="!items.length" class="text-sm text-mid">No activity yet.</p>
    <ul class="space-y-3 max-h-[28rem] overflow-y-auto">
      <li v-for="item in items" :key="item.id" class="text-sm border-b border-white/5 pb-2 last:border-0">
        <div class="flex items-baseline gap-2">
          <span class="font-medium shrink-0" :class="actionColors[item.action] || 'text-mid'">{{ item.action.replace('_', ' ') }}</span>
          <span class="text-white">{{ item.entity_type }}<template v-if="item.entity_id"> #{{ item.entity_id }}</template></span>
          <span class="text-xs text-mid ml-auto shrink-0">{{ new Date(item.created_at).toLocaleString() }}</span>
        </div>
        <div v-if="changesOf(item.parsed).length" class="mt-1 space-y-0.5">
          <p v-for="c in changesOf(item.parsed)" :key="c.field" class="text-xs text-mid">
            <span class="text-white/80">{{ humanizeField(c.field) }}:</span>
            <span class="line-through opacity-60">{{ formatValue(c.from) }}</span>
            <span class="mx-1">→</span>
            <span class="text-white">{{ formatValue(c.to) }}</span>
          </p>
        </div>
        <p v-else-if="extraDetails(item.parsed)" class="mt-1 text-xs text-mid">{{ extraDetails(item.parsed) }}</p>
        <p v-if="item.user_name" class="text-xs text-mid mt-0.5">by {{ item.user_name }}</p>
      </li>
    </ul>
  </div>
</template>
