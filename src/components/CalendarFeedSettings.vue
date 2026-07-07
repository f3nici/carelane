<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

// Per-user read-only iCal subscription. Any calendar app (Google, Apple,
// Outlook) can subscribe to the roster via the secret URL — the feed is scoped
// to the signed-in user (an admin sees every shift, a worker only their own).

const api = useApi()
const toast = useToastStore()
const status = ref(null)
const busy = ref(false)
const open = ref(false)

onMounted(load)

async function load () {
  const res = await api.get('/schedule/calendar-feed')
  status.value = res.data
}

async function generate () {
  busy.value = true
  try {
    const res = await api.post('/schedule/calendar-feed/rotate', {})
    status.value = res.data
    open.value = true
    toast.push('Calendar feed URL ready', 'success')
  } catch { /* */ } finally { busy.value = false }
}

async function rotate () {
  if (!confirm('Generate a new URL? Any calendar already subscribed to the old link will stop updating.')) return
  await generate()
}

async function disable () {
  if (!confirm('Turn off the calendar feed? Subscribed calendars will stop updating.')) return
  busy.value = true
  try {
    const res = await api.del('/schedule/calendar-feed')
    status.value = res.data
    toast.push('Calendar feed disabled', 'success')
  } catch { /* */ } finally { busy.value = false }
}

async function copyUrl () {
  try {
    await navigator.clipboard.writeText(status.value.url)
    toast.push('URL copied', 'success')
  } catch {
    toast.push('Copy failed — select and copy manually', 'error')
  }
}
</script>

<template>
  <div v-if="status" class="card space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-semibold">Calendar subscription (iCal)</h3>
      <span v-if="status.enabled" class="pill bg-success/15 text-success">On</span>
      <span v-else class="pill bg-white/10 text-mid">Off</span>
    </div>

    <p class="text-xs text-mid">
      Subscribe to your roster from any calendar app (Google Calendar, Apple Calendar, Outlook).
      Read-only and one-way — events carry only a short participant label, time and location, never
      plan or health notes. The URL is a private key: anyone with it can see this feed, so share it
      carefully and regenerate it to revoke access.
    </p>

    <div v-if="!status.enabled">
      <button class="btn-primary" :disabled="busy" @click="generate">Enable calendar feed</button>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <input
          :value="open ? status.url : '••••••••••••••••••••••••••••••••'"
          readonly
          class="input font-mono text-xs flex-1 min-w-0"
          @focus="$event.target.select()"
        />
        <button class="btn-ghost text-xs" @click="open = !open">{{ open ? 'Hide' : 'Show' }}</button>
        <button class="btn-ghost text-xs" :disabled="!open" @click="copyUrl">Copy</button>
      </div>
      <p class="text-xs text-mid">
        In your calendar app choose “Subscribe to calendar” / “Add by URL” and paste this address.
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="btn-ghost text-xs" :disabled="busy" @click="rotate">Regenerate URL</button>
        <button class="btn-ghost text-xs text-danger" :disabled="busy" @click="disable">Turn off</button>
      </div>
    </template>
  </div>
</template>
