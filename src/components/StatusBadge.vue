<script setup>
defineProps({
  status: { type: String, required: true }
})

const styles = {
  draft: 'bg-warning/15 text-warning',
  active: 'bg-success/15 text-success',
  final: 'bg-success/15 text-success',
  expired: 'bg-mid/20 text-mid',
  cancelled: 'bg-danger/15 text-danger',
  incident: 'bg-danger/15 text-danger',
  finalised: 'bg-success/15 text-success',
  billed: 'bg-accent/15 text-accent',
  unbilled: 'bg-warning/15 text-warning',
  indexed: 'bg-success/15 text-success',
  indexing: 'bg-warning/15 text-warning',
  // Goal lifecycle
  achieved: 'bg-success/15 text-success',
  on_hold: 'bg-warning/15 text-warning',
  discontinued: 'bg-mid/20 text-mid',
  // Document expiry ('expired' is defined above, reused here)
  expiring: 'bg-warning/15 text-warning'
}

const LABELS = {
  on_hold: 'on hold'
}
</script>

<template>
  <span class="pill" :class="styles[status] || 'bg-white/10 text-mid'">{{ LABELS[status] || status }}</span>
</template>
