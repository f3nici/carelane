<script setup>
import { ref, onMounted } from 'vue'
import { RouterView, RouterLink, useRouter } from 'vue-router'
import axios from 'axios'
import { usePortalAuthStore } from '../stores/portalAuth.js'

/**
 * Minimal, branded shell for the participant-facing client portal. Deliberately
 * unrelated to the staff DefaultLayout/sidebar — a participant sees only the
 * business name, their own name, two sections (Shift notes / Documents) and a
 * sign-out button.
 */
const portal = usePortalAuthStore()
const router = useRouter()
const businessName = ref('CareLane')

onMounted(async () => {
  try {
    const res = await axios.get('/api/v1/portal/auth/config', { withCredentials: true })
    if (res.data.data?.business_name) businessName.value = res.data.data.business_name
  } catch { /* keep the default */ }
})

async function signOut () {
  await portal.logout()
  router.push({ name: 'portal-login' })
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-white/10 bg-surface">
      <div class="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="font-heading text-lg font-semibold truncate">{{ businessName }}</p>
          <p class="text-xs text-mid">Participant portal</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <span v-if="portal.label" class="text-sm text-mid hidden sm:inline">{{ portal.label }}</span>
          <button class="btn-ghost text-xs" @click="signOut">Sign out</button>
        </div>
      </div>
      <nav class="max-w-3xl mx-auto px-4 flex gap-1">
        <RouterLink :to="{ name: 'portal-notes' }" class="portal-tab">Shift notes</RouterLink>
        <RouterLink :to="{ name: 'portal-documents' }" class="portal-tab">Documents</RouterLink>
      </nav>
    </header>

    <main class="flex-1 max-w-3xl w-full mx-auto px-4 py-6">
      <RouterView />
    </main>

    <footer class="border-t border-white/10 py-4 text-center text-xs text-mid">
      Your information is private and read-only. Contact your provider if anything looks incorrect.
    </footer>
  </div>
</template>

<style scoped>
.portal-tab {
  @apply px-3 py-2 text-sm text-mid border-b-2 border-transparent hover:text-white transition-colors;
}
.portal-tab.router-link-active {
  @apply text-white border-primary;
}
</style>
