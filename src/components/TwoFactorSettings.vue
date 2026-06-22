<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const status = ref(null) // { enabled, pending, recovery_codes_remaining }
const setup = ref(null) // { qr_data_url, secret, otpauth_uri }
const token = ref('')
const recoveryCodes = ref(null) // shown once after enabling
const password = ref('')
const busy = ref(false)

onMounted(loadStatus)

async function loadStatus () {
  const res = await api.get('/auth/2fa/status')
  status.value = res.data
}

async function beginSetup () {
  busy.value = true
  try {
    const res = await api.post('/auth/2fa/setup')
    setup.value = res.data
    recoveryCodes.value = null
    token.value = ''
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function enable () {
  busy.value = true
  try {
    const res = await api.post('/auth/2fa/enable', { token: token.value })
    recoveryCodes.value = res.data.recovery_codes
    setup.value = null
    if (auth.user) {
      auth.user.totp_enabled = true
      // A second factor now exists — lift any enrol-to-continue policy gate.
      auth.user.must_enrol_2fa = false
    }
    toast.push('Two-factor authentication enabled', 'success')
    await loadStatus()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function disable () {
  busy.value = true
  try {
    await api.post('/auth/2fa/disable', { password: password.value })
    if (auth.user) auth.user.totp_enabled = false
    password.value = ''
    recoveryCodes.value = null
    toast.push('Two-factor authentication disabled', 'success')
    await loadStatus()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

function copyRecovery () {
  navigator.clipboard?.writeText(recoveryCodes.value.join('\n'))
  toast.push('Recovery codes copied', 'success')
}
</script>

<template>
  <div v-if="status" class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold">Two-factor authentication</h3>
      <span class="pill" :class="status.enabled ? 'bg-success/20 text-success' : 'bg-white/10 text-mid'">
        {{ status.enabled ? 'Enabled' : 'Disabled' }}
      </span>
    </div>
    <p class="text-xs text-mid">Protect your login with a time-based one-time code (TOTP) from an authenticator app such as Google Authenticator, Aegis or 1Password.</p>

    <!-- One-time recovery codes, shown immediately after enabling -->
    <div v-if="recoveryCodes" class="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-2">
      <p class="text-sm font-medium text-warning">Save your recovery codes now</p>
      <p class="text-xs text-mid">Each code works once if you lose your authenticator. They will not be shown again.</p>
      <ul class="grid grid-cols-2 gap-1 font-mono text-sm">
        <li v-for="c in recoveryCodes" :key="c">{{ c }}</li>
      </ul>
      <button class="btn-ghost text-xs" @click="copyRecovery">Copy codes</button>
    </div>

    <!-- Enabled state -->
    <template v-if="status.enabled && !recoveryCodes">
      <p class="text-sm text-mid">{{ status.recovery_codes_remaining }} recovery code(s) remaining.</p>
      <div class="space-y-2">
        <label class="label">Confirm password to disable</label>
        <div class="flex gap-2">
          <input v-model="password" type="password" class="input max-w-xs" autocomplete="current-password" placeholder="Current password" />
          <button class="btn-danger" :disabled="busy || !password" @click="disable">Disable 2FA</button>
        </div>
      </div>
    </template>

    <!-- Setup in progress -->
    <template v-else-if="setup">
      <div class="flex flex-col sm:flex-row gap-4 items-start">
        <img :src="setup.qr_data_url" alt="Scan this QR code in your authenticator app" class="rounded-lg bg-white p-2 shrink-0" />
        <div class="space-y-2 text-sm">
          <p>Scan the QR code, or enter this key manually:</p>
          <code class="block bg-deep rounded-lg px-3 py-2 font-mono text-xs break-all">{{ setup.secret }}</code>
          <label class="label">Enter the 6-digit code to confirm</label>
          <div class="flex gap-2">
            <input v-model="token" class="input max-w-[10rem] tracking-widest" inputmode="numeric" placeholder="123456" />
            <button class="btn-primary" :disabled="busy || !token" @click="enable">Verify & enable</button>
          </div>
        </div>
      </div>
    </template>

    <!-- Disabled, no setup yet -->
    <template v-else-if="!status.enabled">
      <button class="btn-primary" :disabled="busy" @click="beginSetup">Enable two-factor</button>
    </template>
  </div>
</template>
