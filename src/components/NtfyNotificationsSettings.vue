<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const api = useApi()
const toast = useToastStore()
const s = ref(null)
const busy = ref(false)

onMounted(load)

async function load () {
  const res = await api.get('/notifications/status')
  s.value = res.data
}

async function save () {
  busy.value = true
  try {
    const res = await api.put('/notifications/settings', {
      enabled: s.value.enabled ? 1 : 0,
      server_url: s.value.server_url,
      topic: s.value.topic,
      priority: s.value.priority,
      notify_plan_reviews: s.value.notify_plan_reviews ? 1 : 0,
      notify_incidents: s.value.notify_incidents ? 1 : 0,
      notify_unbilled: s.value.notify_unbilled ? 1 : 0,
      notify_shift_reminders: s.value.notify_shift_reminders ? 1 : 0,
      digest_time: s.value.digest_time,
      plan_review_days: s.value.plan_review_days,
      unbilled_days: s.value.unbilled_days,
      shift_reminder_minutes: s.value.shift_reminder_minutes
    })
    s.value = res.data
    toast.push('Notification settings saved', 'success')
  } catch { /* surfaced by the api interceptor */ } finally { busy.value = false }
}

async function test () {
  busy.value = true
  try {
    const res = await api.post('/notifications/test', {})
    if (res.data.ok) toast.push('Test push sent — check your phone', 'success')
    else toast.push(res.data.error || 'Test failed', 'error')
    await load()
  } catch { /* */ } finally { busy.value = false }
}

async function sendNow () {
  busy.value = true
  try {
    const res = await api.post('/notifications/send-now', {})
    if (res.data.sent > 0) toast.push(`Sent ${res.data.sent} nudge${res.data.sent === 1 ? '' : 's'}`, 'success')
    else if (res.data.ok) toast.push('Nothing needs attention right now', 'success')
    else toast.push(res.data.error || 'Could not send', 'error')
    await load()
  } catch { /* */ } finally { busy.value = false }
}

async function clearError () {
  busy.value = true
  try { const res = await api.post('/notifications/clear-error', {}); s.value = res.data } catch { /* */ } finally { busy.value = false }
}
</script>

<template>
  <div v-if="s" class="card space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h3 class="font-semibold">Push notifications (ntfy)</h3>
      <span v-if="s.enabled && s.configured" class="pill bg-success/15 text-success">On</span>
      <span v-else-if="s.configured" class="pill bg-white/10 text-mid">Off</span>
      <span v-else class="pill bg-white/10 text-mid">Not configured</span>
    </div>

    <p class="text-xs text-mid">
      Get proactive nudges on your phone via <a href="https://ntfy.sh" target="_blank" rel="noopener" class="underline">ntfy</a> for plan reviews
      due, incidents needing follow-up, unbilled shifts aging, and upcoming shifts. Pick a hard-to-guess topic name, subscribe to it in the
      ntfy app on your phone, then enter the same topic here. Messages carry only short labels and counts — never plan or health notes.
    </p>

    <!-- Live preview of what a digest would push right now (the dashboard counts). -->
    <div class="rounded-lg bg-white/5 p-3 text-sm grid grid-cols-2 sm:grid-cols-4 gap-2">
      <div><div class="text-lg font-semibold">{{ s.pending.plan_reviews }}</div><div class="text-xs text-mid">Plan reviews due</div></div>
      <div>
        <div class="text-lg font-semibold">{{ s.pending.incidents }}</div>
        <div class="text-xs text-mid">Incidents to follow up<span v-if="s.pending.incidents_overdue" class="text-warning"> ({{ s.pending.incidents_overdue }} overdue)</span></div>
      </div>
      <div><div class="text-lg font-semibold">{{ s.pending.unbilled }}</div><div class="text-xs text-mid">Unbilled shifts aging</div></div>
      <div><div class="text-xs text-mid">Last sent</div><div class="text-xs">{{ s.last_sent_at ? new Date(s.last_sent_at).toLocaleString() : 'never' }}</div></div>
    </div>

    <div v-if="s.last_error" class="flex items-start justify-between gap-2 rounded-lg bg-danger/10 p-3">
      <p class="text-sm text-danger">
        Last error{{ s.last_error.at ? ' (' + new Date(s.last_error.at).toLocaleString() + ')' : '' }}:
        {{ s.last_error.error || 'unknown' }}
      </p>
      <button class="btn-ghost text-xs shrink-0" :disabled="busy" @click="clearError">Clear</button>
    </div>

    <label class="flex items-center gap-2 text-sm"><input v-model="s.enabled" type="checkbox" class="accent-accent" /> Enable push notifications</label>

    <div class="grid sm:grid-cols-2 gap-4">
      <div><label class="label">ntfy server URL</label><input v-model="s.server_url" class="input" placeholder="https://ntfy.sh" /></div>
      <div><label class="label">Topic</label><input v-model="s.topic" class="input font-mono" placeholder="carelane-a1b2c3" /></div>
      <div>
        <label class="label">Priority</label>
        <select v-model="s.priority" class="input">
          <option value="min">Min</option>
          <option value="low">Low</option>
          <option value="default">Default</option>
          <option value="high">High</option>
          <option value="max">Max (urgent)</option>
        </select>
      </div>
      <div>
        <label class="label">Request timeout</label>
        <input :value="s.timeout_ms + ' ms'" class="input" disabled />
        <p class="text-xs text-mid mt-1">Set via <code>NTFY_TIMEOUT_MS</code>. Raise it if a far-away server is slow to respond.</p>
      </div>
    </div>

    <div class="border-t border-white/10 pt-4 space-y-3">
      <h4 class="text-sm font-medium">What to notify about</h4>
      <label class="flex items-center gap-2 text-sm"><input v-model="s.notify_plan_reviews" type="checkbox" class="accent-accent" /> Plan reviews due</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="s.notify_incidents" type="checkbox" class="accent-accent" /> Incidents needing follow-up</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="s.notify_unbilled" type="checkbox" class="accent-accent" /> Unbilled shifts aging</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="s.notify_shift_reminders" type="checkbox" class="accent-accent" /> Upcoming shift reminders</label>
    </div>

    <div class="border-t border-white/10 pt-4 space-y-3">
      <h4 class="text-sm font-medium">Timing</h4>
      <div class="grid sm:grid-cols-2 gap-4">
        <div>
          <label class="label">Daily digest time ({{ s.timezone }})</label>
          <input v-model="s.digest_time" type="time" class="input" />
          <p class="text-xs text-mid mt-1">When the plan-review, incident and unbilled nudges go out each day.</p>
        </div>
        <div>
          <label class="label">Remind me before a shift</label>
          <div class="flex items-center gap-2">
            <input v-model.number="s.shift_reminder_minutes" type="number" min="0" max="1440" class="input w-28" />
            <span class="text-sm text-mid">minutes before</span>
          </div>
        </div>
        <div>
          <label class="label">Plan review lead time</label>
          <div class="flex items-center gap-2">
            <input v-model.number="s.plan_review_days" type="number" min="0" max="365" class="input w-28" />
            <span class="text-sm text-mid">days before end date</span>
          </div>
        </div>
        <div>
          <label class="label">Unbilled shift age</label>
          <div class="flex items-center gap-2">
            <input v-model.number="s.unbilled_days" type="number" min="0" max="365" class="input w-28" />
            <span class="text-sm text-mid">days old before nudging</span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap gap-2">
      <button class="btn-primary" :disabled="busy" @click="save">Save</button>
      <button class="btn-ghost" :disabled="busy || !s.configured" @click="test">Send test</button>
      <button class="btn-ghost" :disabled="busy || !s.configured" @click="sendNow">Send digest now</button>
    </div>
  </div>
</template>
