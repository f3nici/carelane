<script setup>
import { ref } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

defineProps({
  settings: { type: Object, required: true }
})
const emit = defineEmits(['save'])

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()
const logoBusy = ref(false)
const logoVersion = ref(Date.now())

async function uploadLogo (event) {
  const file = event.target.files?.[0]
  if (!file) return
  logoBusy.value = true
  try {
    const form = new FormData()
    form.append('logo', file)
    await api.upload('/settings/logo', form)
    logoVersion.value = Date.now()
    toast.push('Logo uploaded — it will appear on generated PDFs', 'success')
  } catch { /* toast via interceptor */ } finally {
    logoBusy.value = false
  }
}
</script>

<template>
  <div class="card space-y-4">
    <h3 class="font-semibold">Branding & business details</h3>
    <p class="text-xs text-mid">These appear on generated service agreements and reports.</p>
    <div class="grid sm:grid-cols-2 gap-4">
      <div><label class="label">Business name</label><input v-model="settings.business_name" class="input" /></div>
      <div><label class="label">ABN</label><input v-model="settings.abn" class="input" /></div>
      <div><label class="label">Phone</label><input v-model="settings.business_phone" class="input" /></div>
      <div><label class="label">Email</label><input v-model="settings.business_email" class="input" /></div>
      <div class="sm:col-span-2"><label class="label">Address</label><input v-model="settings.business_address" class="input" /></div>
      <div><label class="label">Primary colour</label><input v-model="settings.brand_primary_color" type="color" class="input h-10" /></div>
      <div><label class="label">Accent colour</label><input v-model="settings.brand_accent_color" type="color" class="input h-10" /></div>
    </div>
    <div class="flex items-center gap-4">
      <img v-if="settings.logo_filename" :src="`/api/v1/settings/logo?v=${logoVersion}`" alt="Business logo" class="h-12 rounded bg-white/5 p-1" />
      <label v-if="!auth.isDemo" class="btn-ghost cursor-pointer">
        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="hidden" @change="uploadLogo" />
        {{ logoBusy ? 'Uploading…' : (settings.logo_filename ? 'Replace logo' : 'Upload logo') }}
      </label>
      <p v-else class="text-xs text-mid">Logo upload is disabled in the demo.</p>
    </div>
    <button class="btn-primary" @click="emit('save')">Save branding</button>
  </div>
</template>
