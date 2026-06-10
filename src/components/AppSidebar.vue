<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const auth = useAuthStore()
const router = useRouter()
const stats = ref({})

const nav = [
  { name: 'dashboard', to: '/', label: 'Dashboard', icon: 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10', count: null },
  { name: 'clients', to: '/clients', label: 'Clients', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z', count: 'active_clients' },
  { name: 'agreements', to: '/agreements', label: 'Agreements', icon: 'M9 12h6m-6 4h6M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2z', count: 'agreements_active' },
  { name: 'shifts', to: '/shifts', label: 'Shift Notes', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', count: 'shifts_this_month' },
  { name: 'reports', to: '/reports', label: 'Reports', icon: 'M9 17v-6m4 6V7m4 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z', count: 'draft_reports' },
  { name: 'billing-codes', to: '/billing-codes', label: 'Billing Codes', icon: 'M12 8c-2 0-3 .9-3 2s1 2 3 2 3 .9 3 2-1 2-3 2m0-8V6m0 10v2m9-6a9 9 0 11-18 0 9 9 0 0118 0z', count: null },
  { name: 'knowledge', to: '/knowledge', label: 'Knowledge Base', icon: 'M12 6.25c-2.4-1.5-5.4-1.5-8 0v12c2.6-1.5 5.6-1.5 8 0 2.4-1.5 5.4-1.5 8 0v-12c-2.6-1.5-5.6-1.5-8 0zm0 0v12', count: 'documents_indexed' },
  { name: 'settings', to: '/settings', label: 'Settings', icon: 'M10.3 4.3a1.7 1.7 0 013.4 0 1.7 1.7 0 002.6 1.1 1.7 1.7 0 012.4 2.4 1.7 1.7 0 001 2.5 1.7 1.7 0 010 3.4 1.7 1.7 0 00-1 2.6 1.7 1.7 0 01-2.4 2.4 1.7 1.7 0 00-2.6 1 1.7 1.7 0 01-3.4 0 1.7 1.7 0 00-2.5-1 1.7 1.7 0 01-2.4-2.4 1.7 1.7 0 00-1.1-2.6 1.7 1.7 0 010-3.4 1.7 1.7 0 001.1-2.5 1.7 1.7 0 012.4-2.4 1.7 1.7 0 002.5-1.1zM15 12a3 3 0 11-6 0 3 3 0 016 0z', count: null }
]

onMounted(async () => {
  try {
    const res = await api.get('/dashboard/stats')
    stats.value = res.data
  } catch { /* counts are decorative */ }
})

async function logout () {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <aside class="bg-surface border-white/10 md:w-60 md:min-h-screen md:border-r fixed bottom-0 inset-x-0 z-40 border-t md:static md:border-t-0">
    <div class="hidden md:flex items-center gap-2 px-5 py-5">
      <div class="h-8 w-8 rounded-lg bg-primary flex items-center justify-center font-bold text-white">C</div>
      <span class="font-heading text-lg font-semibold">CareLane</span>
    </div>
    <nav class="flex md:flex-col justify-around md:justify-start md:px-3 md:gap-1 py-1 md:py-0">
      <router-link
        v-for="item in nav"
        :key="item.name"
        :to="item.to"
        class="flex flex-col md:flex-row items-center md:gap-3 rounded-xl px-2 md:px-3 py-2 text-[11px] md:text-sm text-mid hover:text-white hover:bg-white/5 transition-colors"
        :active-class="item.to === '/' ? '' : '!text-white bg-primary/20'"
        exact-active-class="!text-white bg-primary/20"
      >
        <svg class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" /></svg>
        <span class="md:flex-1 truncate">{{ item.label }}</span>
        <span v-if="item.count && stats[item.count]" class="hidden md:inline pill bg-white/10 text-mid">{{ stats[item.count] }}</span>
      </router-link>
    </nav>
    <div class="hidden md:block px-5 py-4 mt-auto md:absolute md:bottom-0 text-xs text-mid">
      <p class="truncate">{{ auth.user?.display_name }}</p>
      <button class="text-accent hover:underline" @click="logout">Sign out</button>
    </div>
  </aside>
</template>
