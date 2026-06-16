<script setup>
import { ref } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const api = useApi()
const toast = useToastStore()

const current = ref('')
const next = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')

const MIN_LENGTH = 10

async function change () {
  error.value = ''
  if (next.value.length < MIN_LENGTH) {
    error.value = `New password must be at least ${MIN_LENGTH} characters.`
    return
  }
  if (next.value !== confirm.value) {
    error.value = 'New password and confirmation do not match.'
    return
  }
  busy.value = true
  try {
    await api.post('/auth/change-password', { current_password: current.value, new_password: next.value })
    current.value = ''
    next.value = ''
    confirm.value = ''
    toast.push('Password changed', 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card space-y-4">
    <h3 class="font-semibold">Password</h3>
    <p class="text-xs text-mid">Change your account password. You will stay signed in on this device. If you are ever locked out, an administrator can reset it from the server with <code>npm run reset-password</code>.</p>
    <form class="space-y-3 max-w-sm" @submit.prevent="change">
      <div>
        <label class="label">Current password</label>
        <input v-model="current" type="password" class="input" autocomplete="current-password" required />
      </div>
      <div>
        <label class="label">New password</label>
        <input v-model="next" type="password" class="input" autocomplete="new-password" required />
      </div>
      <div>
        <label class="label">Confirm new password</label>
        <input v-model="confirm" type="password" class="input" autocomplete="new-password" required />
      </div>
      <p v-if="error" class="text-sm text-danger">{{ error }}</p>
      <button class="btn-primary" :disabled="busy || !current || !next">{{ busy ? 'Saving…' : 'Change password' }}</button>
    </form>
  </div>
</template>
