<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const policy = ref(null) // { require_2fa }
const busy = ref(false)

onMounted(load)

async function load () {
  try {
    const res = await api.get('/auth/security-policy')
    policy.value = res.data
  } catch { /* non-admins get 403; component is hidden for them anyway */ }
}

async function toggle (next) {
  busy.value = true
  try {
    const res = await api.put('/auth/security-policy', { require_2fa: next ? 1 : 0 })
    policy.value = res.data
    toast.push(next ? 'A second factor is now required to sign in' : 'Second-factor requirement removed', 'success')
  } catch { /* toast via interceptor (e.g. POLICY_BLOCKED) */ } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="policy && auth.isAdmin" class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold">Login security policy</h3>
      <span class="pill" :class="policy.require_2fa ? 'bg-success/20 text-success' : 'bg-white/10 text-mid'">
        {{ policy.require_2fa ? 'Second factor required' : 'Optional' }}
      </span>
    </div>
    <p class="text-xs text-mid">
      When required, every account must protect its login with two-factor authentication or a passkey.
      Anyone signing in without one is sent here to set one up before they can use the app. You must set up
      your own second factor before you can turn this on.
    </p>

    <label class="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        class="h-4 w-4 accent-primary"
        :checked="policy.require_2fa"
        :disabled="busy"
        @change="toggle($event.target.checked)"
      />
      <span class="text-sm">Require a second factor (2FA or passkey) for all logins</span>
    </label>
  </div>
</template>
