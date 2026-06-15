<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const api = useApi()
const toast = useToastStore()
const status = ref(null)
const busy = ref(false)
const testResult = ref(null)

onMounted(load)

async function load () {
  const res = await api.get('/invoices/square/status')
  status.value = res.data
}

async function testConnection () {
  busy.value = true
  testResult.value = null
  try {
    const res = await api.post('/invoices/square/test', {})
    testResult.value = res.data
    if (res.data.ok) toast.push('Square reachable', 'success')
    else toast.push(res.data.error || 'Test failed', 'error')
    await load()
  } catch { /* */ } finally { busy.value = false }
}

async function saveSettings () {
  busy.value = true
  try {
    const res = await api.put('/invoices/square/settings', {
      enabled: status.value.enabled ? 1 : 0,
      location_id: status.value.location_id || '',
      currency: status.value.currency || 'AUD'
    })
    status.value = res.data
    toast.push('Square settings saved', 'success')
  } catch { /* */ } finally { busy.value = false }
}

async function clearError () {
  busy.value = true
  try { const res = await api.post('/invoices/square/clear-error', {}); status.value = res.data } catch { /* */ } finally { busy.value = false }
}
</script>

<template>
  <div v-if="status" class="card space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-semibold">Square invoicing</h3>
      <span v-if="status.configured" class="pill bg-success/15 text-success">Configured</span>
      <span v-else class="pill bg-white/10 text-mid">Not configured</span>
    </div>

    <p class="text-xs text-mid">
      Turn a completed shift note into a <strong>draft</strong> invoice in your Square account — you review and
      send it from Square, CareLane never sends it for you. The line item uses the participant's per-item rate
      (set under their billing codes). Requires <code>SQUARE_ACCESS_TOKEN</code> set in the environment.
    </p>

    <p v-if="!status.configured" class="text-sm text-warning">
      Not configured. Add a Square access token to the server environment to enable this.
    </p>

    <template v-else>
      <p class="text-sm text-mid">
        Environment: <span class="font-mono">{{ status.environment }}</span>
        <span v-if="status.location_name"> · Location: {{ status.location_name }}</span>
      </p>

      <div class="rounded-lg bg-white/5 p-3 text-sm space-y-1">
        <div class="flex justify-between gap-3">
          <span class="text-mid">Draft invoices created</span>
          <span>{{ status.invoice_count }}</span>
        </div>
        <div class="flex justify-between gap-3">
          <span class="text-mid">Last invoice</span>
          <span>{{ status.last_invoice_at ? new Date(status.last_invoice_at).toLocaleString() : 'never' }}</span>
        </div>
        <div v-if="status.last_error" class="flex items-start justify-between gap-2">
          <p class="text-danger">
            Last error{{ status.last_error.at ? ' (' + new Date(status.last_error.at).toLocaleString() + ')' : '' }}:
            {{ status.last_error.error || 'unknown' }}
          </p>
          <button class="btn-ghost text-xs shrink-0" :disabled="busy" @click="clearError">Clear</button>
        </div>
        <p v-if="testResult" :class="testResult.ok ? 'text-success' : 'text-danger'">
          <template v-if="testResult.ok">
            Connection OK — location “{{ testResult.location_name || status.location_id }}” ({{ testResult.currency }})
          </template>
          <template v-else>Test failed: {{ testResult.error }}</template>
        </p>
      </div>

      <label class="flex items-center gap-2 text-sm"><input v-model="status.enabled" type="checkbox" class="accent-accent" /> Enable creating Square invoices from shifts</label>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label">Location ID</label><input v-model="status.location_id" class="input font-mono text-xs" placeholder="auto-detected on test" /></div>
        <div><label class="label">Currency</label><input v-model="status.currency" class="input" placeholder="AUD" /></div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-primary" :disabled="busy" @click="saveSettings">Save</button>
        <button class="btn-ghost" :disabled="busy" @click="testConnection">Test connection</button>
      </div>
    </template>
  </div>
</template>
