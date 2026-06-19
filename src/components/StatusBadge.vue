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
  expiring: 'bg-warning/15 text-warning',
  // Incident follow-up lifecycle
  open: 'bg-warning/15 text-warning',
  in_progress: 'bg-info/15 text-info',
  closed: 'bg-mid/20 text-mid',
  reportable: 'bg-danger/15 text-danger',
  // Incident severity
  minor: 'bg-mid/20 text-mid',
  moderate: 'bg-warning/15 text-warning',
  major: 'bg-danger/15 text-danger',
  critical: 'bg-danger/15 text-danger',
  // Medication administration outcome
  administered: 'bg-success/15 text-success',
  refused: 'bg-danger/15 text-danger',
  missed: 'bg-warning/15 text-warning',
  withheld: 'bg-mid/20 text-mid',
  self_administered: 'bg-accent/15 text-accent'
}

const LABELS = {
  on_hold: 'on hold',
  in_progress: 'in progress',
  self_administered: 'self-administered'
}
</script>

<template>
  <span class="pill" :class="styles[status] || 'bg-white/10 text-mid'">{{ LABELS[status] || status }}</span>
</template>
