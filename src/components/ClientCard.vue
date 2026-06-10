<script setup>
import StatusBadge from './StatusBadge.vue'

defineProps({
  client: { type: Object, required: true }
})
</script>

<template>
  <router-link :to="`/clients/${client.id}`" class="card block hover:border-primary/50 transition-colors">
    <div class="flex items-start justify-between gap-2">
      <div>
        <h3 class="font-semibold">{{ client.preferred_name || `${client.first_name} ${client.last_name}` }}</h3>
        <p class="text-xs text-mid mt-0.5">{{ [client.suburb, client.state].filter(Boolean).join(', ') || 'No address' }}</p>
      </div>
      <StatusBadge :status="client.active ? 'active' : 'expired'" />
    </div>
    <dl class="mt-3 grid grid-cols-2 gap-2 text-xs">
      <div><dt class="text-mid">NDIS no.</dt><dd>{{ client.ndis_number || '—' }}</dd></div>
      <div><dt class="text-mid">Plan ends</dt><dd>{{ client.plan_end || '—' }}</dd></div>
    </dl>
  </router-link>
</template>
