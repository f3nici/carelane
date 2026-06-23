<script setup>
/**
 * Terminal-inspired CareLane wordmark. A command-prompt line, the uppercase
 * wordmark and a blinking cursor give the brand a self-hosted, tech-tool feel
 * while staying in the existing blue palette. Optional status tags mirror the
 * shift lifecycle (scheduled → in progress → completed).
 *
 * @prop {'sm'|'md'|'lg'} size   Visual scale. sm = sidebar, md = login, lg = hero.
 * @prop {boolean} prompt        Show the `$ carelane --flag` prompt line.
 * @prop {boolean} tags          Show the status tags beneath the wordmark.
 * @prop {string}  flag          Trailing prompt flag (e.g. `--status`, `--docs`).
 */
defineProps({
  size: { type: String, default: 'md' },
  prompt: { type: Boolean, default: true },
  tags: { type: Boolean, default: false },
  flag: { type: String, default: '--status' }
})
</script>

<template>
  <div class="brand" :class="`brand--${size}`" aria-label="CareLane">
    <div v-if="prompt" class="brand__prompt" aria-hidden="true">
      <span>$</span> carelane <span>{{ flag }}</span>
    </div>
    <div class="brand__name">CARELANE<span class="brand__cursor" aria-hidden="true"></span></div>
    <div v-if="tags" class="brand__tags" aria-hidden="true">
      <span class="brand__tag brand__tag--scheduled">scheduled</span>
      <span class="brand__tag brand__tag--progress">in progress</span>
      <span class="brand__tag brand__tag--done">completed</span>
    </div>
  </div>
</template>

<style scoped>
.brand {
  text-align: left;
  line-height: 1;
}

.brand__prompt {
  font-family: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
  color: #6b7280;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.brand__prompt span { color: #14b8a6; }

.brand__name {
  font-family: 'Oswald', 'Sora', sans-serif;
  font-weight: 700;
  color: #ffffff;
  text-transform: uppercase;
  line-height: 1;
  white-space: nowrap;
}

.brand__cursor {
  display: inline-block;
  height: 0.82em;
  background: #2563eb;
  vertical-align: baseline;
  border-radius: 1px;
  animation: brand-blink 1.05s step-end infinite;
}

@keyframes brand-blink { 50% { opacity: 0; } }

.brand__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.brand__tag {
  font-family: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  border-radius: 4px;
  white-space: nowrap;
}
.brand__tag--scheduled { background: rgba(14, 165, 233, 0.15); color: #0ea5e9; }
.brand__tag--progress  { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
.brand__tag--done      { background: rgba(34, 197, 94, 0.15); color: #22c55e; }

/* sm — sidebar / mobile bar */
.brand--sm .brand__prompt { font-size: 0.5rem; margin-bottom: 3px; }
.brand--sm .brand__name { font-size: 1.4rem; letter-spacing: 2px; }
.brand--sm .brand__cursor { width: 2px; margin-left: 4px; }
.brand--sm .brand__tags { margin-top: 7px; }
.brand--sm .brand__tag { font-size: 0.5rem; padding: 2px 7px; }

/* md — login */
.brand--md .brand__prompt { font-size: 0.62rem; margin-bottom: 5px; }
.brand--md .brand__name { font-size: 2.1rem; letter-spacing: 3px; }
.brand--md .brand__cursor { width: 3px; margin-left: 6px; }
.brand--md .brand__tags { margin-top: 10px; }
.brand--md .brand__tag { font-size: 0.55rem; padding: 3px 9px; }

/* lg — hero / large placements */
.brand--lg .brand__prompt { font-size: 0.72rem; margin-bottom: 7px; }
.brand--lg .brand__name { font-size: 3rem; letter-spacing: 4px; }
.brand--lg .brand__cursor { width: 4px; margin-left: 8px; }
.brand--lg .brand__tags { margin-top: 12px; }
.brand--lg .brand__tag { font-size: 0.6rem; padding: 3px 11px; }

@media (prefers-reduced-motion: reduce) {
  .brand__cursor { animation: none; }
}
</style>
