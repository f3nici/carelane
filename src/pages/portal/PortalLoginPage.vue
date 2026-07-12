<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { useRouter, useRoute } from 'vue-router'
import { usePortalAuthStore } from '../../stores/portalAuth.js'

/**
 * Client-portal sign-in. A standalone page (not the staff LoginPage) using the
 * portal auth store. In demo mode it advertises + pre-fills the example
 * participant login.
 */
const portal = usePortalAuthStore()
const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
const businessName = ref('CareLane')
const demo = ref(null)

onMounted(async () => {
  try {
    const res = await axios.get('/api/v1/portal/auth/config', { withCredentials: true })
    const cfg = res.data.data || {}
    if (cfg.business_name) businessName.value = cfg.business_name
    if (cfg.demo) {
      demo.value = cfg
      username.value = cfg.demo_username
      password.value = cfg.demo_password
    }
  } catch { /* offline or misconfigured — sign in normally */ }
})

/** Same-site single-slash redirect only (closes the open-redirect). */
function safeRedirect () {
  const r = route.query.redirect
  return typeof r === 'string' && /^\/(?!\/)/.test(r) ? r : '/portal'
}

async function submit () {
  busy.value = true
  error.value = ''
  try {
    await portal.login(username.value, password.value)
    router.push(safeRedirect())
  } catch (err) {
    error.value = err.response?.data?.error?.message || 'Sign in failed'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="card w-full max-w-sm">
      <div class="mb-6">
        <p class="font-heading text-2xl font-semibold">{{ businessName }}</p>
        <p class="text-xs text-mid mt-1">Participant portal — view your shift notes and documents</p>
      </div>

      <div v-if="demo" class="mb-5 rounded-xl border border-accent/40 bg-accent/10 p-4 space-y-1">
        <p class="text-sm font-medium text-accent">CareLane demo — participant view</p>
        <p class="text-xs text-mid">
          Just press <span class="font-medium text-white">Sign in</span> to look around as an example participant.
          The demo portal login is <code>{{ demo.demo_username }}</code> / <code>{{ demo.demo_password }}</code> (already filled in).
        </p>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="label" for="portal-username">Username</label>
          <input id="portal-username" v-model="username" class="input" autocomplete="username" required />
        </div>
        <div>
          <label class="label" for="portal-password">Password</label>
          <input id="portal-password" v-model="password" type="password" class="input" autocomplete="current-password" required />
        </div>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      </form>

      <p class="text-xs text-mid mt-5">
        Trouble signing in? Contact your support provider — they manage your portal access.
      </p>
    </div>
  </div>
</template>
