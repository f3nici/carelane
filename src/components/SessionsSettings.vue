<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()
const router = useRouter()

const sessions = ref([])
const busy = ref(false)

onMounted(load)

async function load () {
  const res = await api.get('/auth/sessions')
  sessions.value = res.data.sessions
}

async function revoke (session) {
  if (session.current) {
    if (!confirm('Sign out this device now?')) return
  } else if (!confirm('Sign out this session? The device will need to log in again.')) {
    return
  }
  busy.value = true
  try {
    await api.del(`/auth/sessions/${encodeURIComponent(session.sid)}`)
    if (session.current) {
      auth.clear()
      router.push({ name: 'login' })
      return
    }
    toast.push('Session signed out', 'success')
    await load()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function revokeOthers () {
  if (!confirm('Sign out every other session? This keeps you signed in here.')) return
  busy.value = true
  try {
    const res = await api.post('/auth/sessions/revoke-others')
    toast.push(`Signed out ${res.data.revoked} other session(s)`, 'success')
    await load()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

/** A friendly device label parsed from the user-agent. */
function deviceLabel (ua) {
  if (!ua) return 'Unknown device'
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS device'
  if (/Android/.test(ua)) return 'Android device'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Browser'
}

function formatDate (iso) {
  return iso ? new Date(iso).toLocaleString() : '—'
}
</script>

<template>
  <div class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold">Active sessions &amp; devices</h3>
      <button
        v-if="sessions.length > 1"
        class="btn-ghost text-xs"
        :disabled="busy"
        @click="revokeOthers"
      >Sign out all others</button>
    </div>
    <p class="text-xs text-mid">Devices currently signed in to your account. Revoke any you don't recognise — they'll be signed out immediately.</p>

    <ul v-if="sessions.length" class="divide-y divide-white/10">
      <li v-for="s in sessions" :key="s.sid" class="flex items-center justify-between gap-2 py-2">
        <div class="min-w-0">
          <p class="text-sm flex items-center gap-2">
            {{ deviceLabel(s.user_agent) }}
            <span v-if="s.current" class="pill bg-primary/20 text-primary text-xs">This device</span>
          </p>
          <p class="text-xs text-mid truncate">{{ s.ip || 'unknown IP' }} · Last active {{ formatDate(s.last_seen_at) }}</p>
        </div>
        <button class="btn-ghost text-xs text-danger shrink-0" :disabled="busy" @click="revoke(s)">
          {{ s.current ? 'Sign out' : 'Revoke' }}
        </button>
      </li>
    </ul>
    <p v-else class="text-sm text-mid">No active sessions found.</p>
  </div>
</template>
