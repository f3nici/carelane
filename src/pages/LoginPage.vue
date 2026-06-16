<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const token = ref('')
const totpRequired = ref(false)
const tokenInput = ref(null)
const error = ref('')
const busy = ref(false)
const passkeyBusy = ref(false)
const supportsPasskeys = ref(false)

onMounted(() => { supportsPasskeys.value = auth.supportsPasskeys() })

/**
 * Resolve the post-login redirect target safely. Only same-site, single-slash
 * absolute paths are allowed; anything else (a protocol-relative `//evil.com`,
 * an absolute URL, a non-string) falls back to the dashboard — closing the
 * open-redirect via a crafted `?redirect=` link.
 */
function safeRedirect () {
  const r = route.query.redirect
  return typeof r === 'string' && /^\/(?!\/)/.test(r) ? r : '/'
}

async function submit () {
  busy.value = true
  error.value = ''
  try {
    const { totpRequired: needs2fa } = await auth.login(username.value, password.value, token.value || undefined)
    if (needs2fa) {
      // Password was right but a code is required and the field was left blank.
      totpRequired.value = true
      error.value = 'Enter your authentication code to continue.'
      await nextTick()
      tokenInput.value?.focus()
      return
    }
    router.push(safeRedirect())
  } catch (err) {
    error.value = err.response?.data?.error?.message || 'Login failed'
  } finally {
    busy.value = false
  }
}

async function signInWithPasskey () {
  passkeyBusy.value = true
  error.value = ''
  try {
    await auth.loginWithPasskey()
    router.push(safeRedirect())
  } catch (err) {
    // A user cancelling the prompt is not an error worth shouting about.
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return
    error.value = err.response?.data?.error?.message || 'Passkey sign-in failed or was cancelled.'
  } finally {
    passkeyBusy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="card w-full max-w-sm">
      <div class="flex items-center gap-2 mb-6">
        <img src="/icon.svg" alt="CareLane" class="h-10 w-10" />
        <div>
          <h1 class="font-heading text-xl font-semibold">CareLane</h1>
          <p class="text-xs text-mid">NDIS support worker management</p>
        </div>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="label" for="username">Username</label>
          <input id="username" v-model="username" class="input" autocomplete="username" required />
        </div>
        <div>
          <label class="label" for="password">Password</label>
          <input id="password" v-model="password" type="password" class="input" autocomplete="current-password" required />
        </div>
        <div>
          <label class="label" for="token">Authentication code</label>
          <input id="token" ref="tokenInput" v-model="token" class="input tracking-widest" autocomplete="one-time-code" inputmode="numeric" placeholder="123456" />
          <p class="text-xs text-mid mt-1">If two-factor authentication is enabled, enter the 6-digit code from your authenticator app (or a recovery code). Otherwise leave this blank.</p>
        </div>
        <p v-if="error" class="text-sm" :class="totpRequired ? 'text-mid' : 'text-danger'">{{ error }}</p>
        <button class="btn-primary w-full" :disabled="busy || passkeyBusy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      </form>

      <template v-if="supportsPasskeys">
        <div class="flex items-center gap-3 my-4">
          <span class="h-px flex-1 bg-white/10"></span>
          <span class="text-xs text-mid">or</span>
          <span class="h-px flex-1 bg-white/10"></span>
        </div>
        <button class="btn-ghost w-full" :disabled="busy || passkeyBusy" @click="signInWithPasskey">
          {{ passkeyBusy ? 'Waiting for passkey…' : 'Sign in with a passkey' }}
        </button>
      </template>
    </div>
  </div>
</template>
