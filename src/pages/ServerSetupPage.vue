<script setup>
import { ref } from 'vue'
import { serverBase, setServerBase, serverSetupOpen } from '../composables/serverBase.js'
import BrandLogo from '../components/BrandLogo.vue'

/*
 * Native-app first-launch screen: asks for the address of the self-hosted
 * CareLane server. Verifies it responds on /healthz before saving, then
 * reloads so every axios instance picks up the new base.
 */

const address = ref(serverBase())
const busy = ref(false)
const error = ref('')
const canCancel = !!serverBase()

/** Normalise what the user typed into an origin (https assumed, no trailing /). */
function normalise (input) {
  let url = input.trim()
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/\/+$/, '')
  try { return new URL(url).origin } catch { return null }
}

async function connect () {
  error.value = ''
  const origin = normalise(address.value)
  if (!origin) {
    error.value = 'Enter a server address, e.g. https://carelane.example.com'
    return
  }
  busy.value = true
  try {
    const res = await fetch(origin + '/healthz')
    if (!res.ok) throw new Error('unhealthy')
    setServerBase(origin)
    // Full reload so the axios instances rebuild with the new base.
    window.location.reload()
  } catch {
    error.value = 'Could not reach a CareLane server at ' + origin + '. Check the address, and make sure the server allows the app (SESSION_SAMESITE=none in its environment).'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="card w-full max-w-sm">
      <div class="mb-6">
        <BrandLogo size="md" tags class="mb-3" />
        <p class="text-xs text-mid">Connect to your CareLane server</p>
      </div>

      <form class="space-y-4" @submit.prevent="connect">
        <div>
          <label class="label" for="server">Server address</label>
          <input
            id="server" v-model="address" class="input" placeholder="https://carelane.example.com"
            autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" required
          />
          <p class="text-xs text-mid mt-1">The HTTPS address of your self-hosted CareLane server. You can change it later from the sign-in screen.</p>
        </div>
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Checking…' : 'Connect' }}</button>
        <button v-if="canCancel" type="button" class="btn-ghost w-full" :disabled="busy" @click="serverSetupOpen = false">Cancel</button>
      </form>
    </div>
  </div>
</template>
