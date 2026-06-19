<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from '../stores/auth.js'

const emit = defineEmits(['open-search'])

const api = useApi()
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const stats = ref({})
const mobileOpen = ref(false)

function openSearch () {
  mobileOpen.value = false
  emit('open-search')
}

const nav = [
  { name: 'dashboard', to: '/', label: 'Dashboard', icon: 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10', count: null },
  { name: 'clients', to: '/clients', label: 'Clients', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z', count: 'active_clients' },
  { name: 'roster', to: '/roster', label: 'Roster', icon: 'M8 7V3m8 4V3m-9 8h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', count: 'upcoming_shifts' },
  { name: 'shifts', to: '/shifts', label: 'Notes', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', count: 'unfinalised_notes' },
  { name: 'incidents', to: '/incidents', label: 'Incidents', icon: 'M12 9v4m0 4h.01M10.3 3.86l-8.4 14.5A1.5 1.5 0 003.2 21h17.6a1.5 1.5 0 001.3-2.64L13.7 3.86a1.5 1.5 0 00-2.6 0z', count: 'open_incident_reports' },
  { name: 'documents', to: '/documents', label: 'Documents', icon: 'M9 12h6m-6 4h6M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2z', count: null },
  { name: 'knowledge', to: '/knowledge', label: 'Knowledge Base', icon: 'M12 6.25c-2.4-1.5-5.4-1.5-8 0v12c2.6-1.5 5.6-1.5 8 0 2.4-1.5 5.4-1.5 8 0v-12c-2.6-1.5-5.6-1.5-8 0zm0 0v12', count: 'documents_indexed' },
  { name: 'deleted', to: '/deleted', label: 'Deleted Items', icon: 'M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16', count: null },
  { name: 'settings', to: '/settings', label: 'Settings', icon: 'M10.3 4.3a1.7 1.7 0 013.4 0 1.7 1.7 0 002.6 1.1 1.7 1.7 0 012.4 2.4 1.7 1.7 0 001 2.5 1.7 1.7 0 010 3.4 1.7 1.7 0 00-1 2.6 1.7 1.7 0 01-2.4 2.4 1.7 1.7 0 00-2.6 1 1.7 1.7 0 01-3.4 0 1.7 1.7 0 00-2.5-1 1.7 1.7 0 01-2.4-2.4 1.7 1.7 0 00-1.1-2.6 1.7 1.7 0 010-3.4 1.7 1.7 0 001.1-2.5 1.7 1.7 0 012.4-2.4 1.7 1.7 0 002.5-1.1zM15 12a3 3 0 11-6 0 3 3 0 016 0z', count: null }
]

// Close the mobile drawer whenever the route changes.
watch(() => route.fullPath, () => { mobileOpen.value = false })

onMounted(async () => {
  try {
    const res = await api.get('/dashboard/stats')
    stats.value = res.data
  } catch { /* counts are decorative */ }
})

async function logout () {
  mobileOpen.value = false
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <!-- Mobile top app bar with hamburger -->
  <header class="md:hidden fixed top-0 inset-x-0 z-30 h-14 flex items-center gap-3 bg-surface/95 backdrop-blur border-b border-white/10 px-4">
    <button
      class="-ml-1 p-2 rounded-lg text-mid hover:text-white hover:bg-white/5 transition-colors"
      aria-label="Open menu"
      @click="mobileOpen = true"
    >
      <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    <img src="/icon.svg" alt="" class="h-7 w-7" />
    <span class="font-heading text-base font-semibold">CareLane</span>
  </header>

  <!-- Drawer backdrop (mobile only) -->
  <div
    v-if="mobileOpen"
    class="md:hidden fixed inset-0 z-40 bg-black/60"
    @click="mobileOpen = false"
  ></div>

  <!-- Sidebar (desktop) / slide-in drawer (mobile) -->
  <aside
    class="bg-surface border-white/10 fixed inset-y-0 left-0 z-50 w-64 flex flex-col transition-transform duration-200 md:static md:z-auto md:w-60 md:min-h-screen md:border-r md:translate-x-0"
    :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'"
  >
    <div class="flex items-center gap-2 px-5 py-5">
      <img src="/icon.svg" alt="" class="h-8 w-8" />
      <span class="font-heading text-lg font-semibold">CareLane</span>
      <button
        class="md:hidden ml-auto p-1.5 rounded-lg text-mid hover:text-white hover:bg-white/5 transition-colors"
        aria-label="Close menu"
        @click="mobileOpen = false"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
    <div class="px-3 pb-2">
      <button
        class="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-mid bg-white/5 hover:bg-white/10 hover:text-white transition-colors"
        @click="openSearch"
      >
        <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.3-4.3M11 18a7 7 0 110-14 7 7 0 010 14z" /></svg>
        <span class="flex-1 text-left">Search clients</span>
        <span class="pill bg-white/10 text-mid hidden md:inline">⌘K</span>
      </button>
    </div>
    <nav class="flex-1 overflow-y-auto flex flex-col px-3 gap-1">
      <router-link
        v-for="item in nav"
        :key="item.name"
        :to="item.to"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-mid hover:text-white hover:bg-white/5 transition-colors"
        :active-class="item.to === '/' ? '' : '!text-white bg-primary/20'"
        exact-active-class="!text-white bg-primary/20"
      >
        <svg class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" /></svg>
        <span class="flex-1 truncate">{{ item.label }}</span>
        <span v-if="item.count && stats[item.count]" class="pill bg-white/10 text-mid">{{ stats[item.count] }}</span>
      </router-link>
    </nav>
    <div class="px-5 py-4 border-t border-white/10 text-xs text-mid">
      <p class="truncate">{{ auth.user?.display_name }}</p>
      <button class="text-accent hover:underline" @click="logout">Sign out</button>
    </div>
  </aside>
</template>
