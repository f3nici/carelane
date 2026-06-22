<script setup>
import { ref, onMounted } from 'vue'
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const supported = ref(false)
const passkeys = ref([])
const newName = ref('')
const password = ref('')
const busy = ref(false)

onMounted(async () => {
  supported.value = browserSupportsWebAuthn()
  if (supported.value) await load()
})

async function load () {
  const res = await api.get('/auth/passkeys')
  passkeys.value = res.data.passkeys
}

async function register () {
  if (!password.value) {
    toast.push('Enter your current password to add a passkey', 'error')
    return
  }
  busy.value = true
  try {
    // Re-authenticate first; the password is verified server-side before any
    // WebAuthn challenge is issued.
    const optRes = await api.post('/auth/passkeys/register/options', { password: password.value })
    const attResp = await startRegistration({ optionsJSON: optRes.data })
    await api.post('/auth/passkeys/register/verify', { response: attResp, name: newName.value || undefined })
    newName.value = ''
    password.value = ''
    // A passkey counts as a second factor — lift any enrol-to-continue gate.
    if (auth.user) auth.user.must_enrol_2fa = false
    toast.push('Passkey added', 'success')
    await load()
  } catch (err) {
    // Cancelling the browser prompt is not an error worth a toast.
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError' && err?.response == null) {
      toast.push(err.message || 'Could not add passkey', 'error')
    }
  } finally {
    busy.value = false
  }
}

async function remove (passkey) {
  // Removing a login factor requires password re-entry server-side; reuse the
  // password field above rather than silently failing the request.
  if (!password.value) {
    toast.push('Enter your current password (below) to remove a passkey', 'error')
    return
  }
  if (!confirm(`Remove passkey "${passkey.name}"? You will no longer be able to sign in with it.`)) return
  try {
    await api.del(`/auth/passkeys/${passkey.id}`, { password: password.value })
    password.value = ''
    toast.push('Passkey removed', 'success')
    await load()
  } catch { /* toast via interceptor */ }
}

function formatDate (iso) {
  return iso ? new Date(iso).toLocaleDateString() : '—'
}
</script>

<template>
  <div class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold">Passkeys</h3>
      <span class="pill" :class="passkeys.length ? 'bg-success/20 text-success' : 'bg-white/10 text-mid'">
        {{ passkeys.length }} registered
      </span>
    </div>
    <p class="text-xs text-mid">Passkeys let you sign in without a password using your device's fingerprint, face or screen lock (or a hardware security key). They are phishing-resistant and never leave your device.</p>

    <p v-if="!supported" class="text-sm text-warning">This browser does not support passkeys.</p>

    <template v-else>
      <ul v-if="passkeys.length" class="divide-y divide-white/10">
        <li v-for="p in passkeys" :key="p.id" class="flex items-center justify-between gap-2 py-2">
          <div>
            <p class="text-sm">{{ p.name }}</p>
            <p class="text-xs text-mid">Added {{ formatDate(p.created_at) }} · Last used {{ formatDate(p.last_used_at) }}</p>
          </div>
          <button class="btn-ghost text-xs text-danger" @click="remove(p)">Remove</button>
        </li>
      </ul>

      <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div class="flex-1">
          <label class="label">Name (optional)</label>
          <input v-model="newName" class="input" placeholder="e.g. My laptop" maxlength="60" />
        </div>
        <div class="flex-1">
          <label class="label">Current password</label>
          <input v-model="password" type="password" class="input" placeholder="Confirm it's you" autocomplete="current-password" />
        </div>
        <button class="btn-primary shrink-0" :disabled="busy" @click="register">{{ busy ? 'Waiting…' : 'Add a passkey' }}</button>
      </div>
    </template>
  </div>
</template>
