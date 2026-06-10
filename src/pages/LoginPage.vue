<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit () {
  busy.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value)
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
          <input id="username" v-model="username" class="input" autocomplete="username" required />
        </div>
        <div>
          <label class="label" for="password">Password</label>
          <input id="password" v-model="password" type="password" class="input" autocomplete="current-password" required />
        </div>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      </form>
    </div>
  </div>
</template>
