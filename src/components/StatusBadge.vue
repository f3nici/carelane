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
  indexing: 'bg-warning/15 text-warning'
}
</script>

<template>
  <span class="pill" :class="styles[status] || 'bg-white/10 text-mid'">{{ status }}</span>
</template>
