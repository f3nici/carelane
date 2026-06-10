<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import BrandingSettings from '../components/BrandingSettings.vue'
import TwoFactorSettings from '../components/TwoFactorSettings.vue'
import BackupSettings from '../components/BackupSettings.vue'

const api = useApi()
const toast = useToastStore()
const settings = ref(null)

onMounted(async () => {
  const res = await api.get('/settings')
  settings.value = res.data
})

async function save () {
  await api.put('/settings', settings.value)
  toast.push('Settings saved', 'success')
}
</script>

<template>
  <div v-if="settings" class="space-y-6 max-w-3xl">
    <h1 class="text-2xl font-semibold">Settings</h1>

    <BrandingSettings :settings="settings" @save="save" />

    <TwoFactorSettings />

    <BackupSettings />

    <div class="card space-y-4">
      <h3 class="font-semibold">AI models</h3>
      <p class="text-xs text-mid">Model IDs are configurable so they can be upgraded without a code change. The API key itself is set via the <code>ANTHROPIC_API_KEY</code> environment variable, never stored here.</p>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label">Cheap model (notes, condensing)</label><input v-model="settings.claude_model_cheap" class="input font-mono text-xs" /></div>
        <div><label class="label">Quality model (agreements, reports)</label><input v-model="settings.claude_model_quality" class="input font-mono text-xs" /></div>
        <div class="sm:col-span-2"><label class="label">Writing tone</label><input v-model="settings.ai_tone" class="input" /></div>
      </div>
      <button class="btn-primary" @click="save">Save AI settings</button>
    </div>

    <div class="card space-y-2">
      <h3 class="font-semibold">Privacy & data</h3>
      <ul class="text-sm text-mid list-disc pl-5 space-y-1">
        <li>Participant PII and note bodies are encrypted at rest (AES-256-GCM) using <code>ENCRYPTION_SECRET</code>. That secret cannot be rotated casually — changing it makes existing data unreadable. Back it up securely.</li>
        <li>Nothing is sent to third parties except the minimal, de-identified context of AI drafting calls you explicitly trigger.</li>
        <li>Regulated records (participants, agreements, shifts, billing) are soft-deleted only, honouring NDIS record retention.</li>
        <li>Nightly database backups run at the configured time with retention applied.</li>
      </ul>
    </div>

    <p class="text-xs text-mid">{{ settings.disclaimer }}</p>
  </div>
</template>
