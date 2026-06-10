<script setup>
import { ref, nextTick } from 'vue'
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

async function submit () {
  busy.value = true
  error.value = ''
  try {
    const { totpRequired: needs2fa } = await auth.login(username.value, password.value, token.value || undefined)
    if (needs2fa) {
      totpRequired.value = true
      await nextTick()
      tokenInput.value?.focus()
      return
    }
    router.push(route.query.redirect || '/')
  } catch (err) {
    error.value = err.response?.data?.error?.message || 'Login failed'
  } finally {
    busy.value = false
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
          <input id="username" v-model="username" class="input" autocomplete="username" :disabled="totpRequired" required />
        </div>
        <div>
          <label class="label" for="password">Password</label>
          <input id="password" v-model="password" type="password" class="input" autocomplete="current-password" :disabled="totpRequired" required />
        </div>
        <div v-if="totpRequired">
          <label class="label" for="token">Authentication code</label>
          <input id="token" ref="tokenInput" v-model="token" class="input tracking-widest" autocomplete="one-time-code" inputmode="numeric" placeholder="123456" required />
          <p class="text-xs text-mid mt-1">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
        </div>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Signing in…' : (totpRequired ? 'Verify' : 'Sign in') }}</button>
      </form>
    </div>
  </div>
</template>
