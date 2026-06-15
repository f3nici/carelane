<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const api = useApi()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()
const status = ref(null)
const busy = ref(false)
const testResult = ref(null)

onMounted(async () => {
  await load()
  // The OAuth callback redirects back here with a result flag.
  if (route.query.google === 'connected') toast.push('Google Calendar connected', 'success')
  else if (route.query.google === 'error') toast.push('Google Calendar connection failed', 'error')
  if (route.query.google) router.replace({ query: { ...route.query, google: undefined } })
})

async function load () {
  const res = await api.get('/schedule/google/status')
  status.value = res.data
}

async function connect () {
  busy.value = true
  try {
    const res = await api.get('/schedule/google/connect')
    window.location.href = res.data.url
  } catch { busy.value = false }
}

async function testConnection () {
  busy.value = true
  testResult.value = null
  try {
    const res = await api.post('/schedule/google/test', {})
    testResult.value = res.data
    if (res.data.ok) toast.push('Google Calendar reachable', 'success')
    else toast.push(res.data.error || 'Test failed', 'error')
    await load()
  } catch { /* */ } finally { busy.value = false }
}

async function syncAll () {
  busy.value = true
  testResult.value = null
  try {
    const res = await api.post('/schedule/google/sync-all', {})
    const { total, synced, failed } = res.data
    if (failed > 0) toast.push(`Synced ${synced}/${total} shifts — ${failed} failed`, 'error')
    else toast.push(`Synced ${synced} shift${synced === 1 ? '' : 's'}`, 'success')
    await load()
  } catch { /* */ } finally { busy.value = false }
}

async function clearError () {
  busy.value = true
  try { const res = await api.post('/schedule/google/clear-error', {}); status.value = res.data } catch { /* */ } finally { busy.value = false }
}

async function disconnect () {
  if (!confirm('Disconnect Google Calendar? Future shifts will no longer sync.')) return
  busy.value = true
  try { const res = await api.post('/schedule/google/disconnect', {}); status.value = res.data; toast.push('Disconnected', 'success') } catch { /* */ } finally { busy.value = false }
}

async function saveSettings () {
  busy.value = true
  try {
    const res = await api.put('/schedule/google/settings', {
      enabled: status.value.enabled ? 1 : 0,
      calendar_id: status.value.calendar_id,
      timezone: status.value.timezone
    })
    status.value = res.data
    toast.push('Google Calendar settings saved', 'success')
  } catch { /* */ } finally { busy.value = false }
}
</script>

<template>
  <div v-if="status" class="card space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-semibold">Google Calendar</h3>
      <span v-if="status.connected" class="pill bg-success/15 text-success">Connected</span>
      <span v-else class="pill bg-white/10 text-mid">Not connected</span>
    </div>

    <p class="text-xs text-mid">
      Push scheduled shifts to your Google Calendar as events (one-way). Events carry only a short
      participant label and location — never plan or health notes. Requires
      <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> set in the environment.
    </p>

    <p v-if="!status.configured" class="text-sm text-warning">
      Not configured. Add Google OAuth credentials to the server environment to enable this.
    </p>

    <template v-else>
      <div v-if="!status.connected">
        <button class="btn-primary" :disabled="busy" @click="connect">Connect Google Calendar</button>
      </div>
      <template v-else>
        <p v-if="status.account_email" class="text-sm text-mid">Account: {{ status.account_email }}</p>

        <!-- Sync health: lets the operator confirm the integration is actually working. -->
        <div class="rounded-lg bg-white/5 p-3 text-sm space-y-1">
          <div class="flex justify-between gap-3">
            <span class="text-mid">Shifts mirrored</span>
            <span>{{ status.synced_shifts }}</span>
          </div>
          <div class="flex justify-between gap-3">
            <span class="text-mid">Last successful sync</span>
            <span>{{ status.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : 'never' }}</span>
          </div>
          <div v-if="status.last_sync_error" class="flex items-start justify-between gap-2">
            <p class="text-danger">
              Last error{{ status.last_sync_error.at ? ' (' + new Date(status.last_sync_error.at).toLocaleString() + ')' : '' }}:
              {{ status.last_sync_error.error || 'unknown' }}
            </p>
            <button class="btn-ghost text-xs shrink-0" :disabled="busy" @click="clearError">Clear</button>
          </div>
          <p v-if="testResult" :class="testResult.ok ? 'text-success' : 'text-danger'">
            <template v-if="testResult.ok">
              Connection OK — calendar “{{ testResult.calendar_summary || status.calendar_id }}”{{ testResult.calendar_timezone ? ' (' + testResult.calendar_timezone + ')' : '' }}
            </template>
            <template v-else>Test failed: {{ testResult.error }}</template>
          </p>
        </div>

        <label class="flex items-center gap-2 text-sm"><input v-model="status.enabled" type="checkbox" class="accent-accent" /> Sync scheduled shifts to Google Calendar</label>
        <div class="grid sm:grid-cols-2 gap-4">
          <div><label class="label">Calendar ID</label><input v-model="status.calendar_id" class="input" placeholder="primary" /></div>
          <div><label class="label">Timezone</label><input v-model="status.timezone" class="input" placeholder="Australia/Perth" /></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn-primary" :disabled="busy" @click="saveSettings">Save</button>
          <button class="btn-ghost" :disabled="busy" @click="testConnection">Test connection</button>
          <button class="btn-ghost" :disabled="busy || !status.enabled" @click="syncAll">Sync all shifts</button>
          <button class="btn-ghost text-danger" :disabled="busy" @click="disconnect">Disconnect</button>
        </div>
      </template>
    </template>
  </div>
</template>
