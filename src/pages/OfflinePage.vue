<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useOfflineStore } from '../stores/offline.js'
import { listDrafts } from '../composables/offlineDrafts.js'

const offline = useOfflineStore()
const router = useRouter()
const drafts = ref([])

async function loadDrafts () {
  try { drafts.value = await listDrafts() } catch { drafts.value = [] }
}

onMounted(loadDrafts)
// Keep the parked-note list fresh as the pending count changes.
watch(() => offline.pending, loadDrafts)

// The moment we're back online there's no reason to sit on the offline screen —
// drop the worker back to the dashboard (drafts sync automatically).
watch(() => offline.online, online => { if (online) router.replace('/') })

const heading = computed(() => offline.online ? 'Back online' : "You're offline")
</script>

<template>
  <div class="max-w-xl mx-auto space-y-6">
    <div class="card text-center space-y-3">
      <div class="mx-auto h-12 w-12 rounded-full bg-white/5 flex items-center justify-center">
        <svg class="h-6 w-6 text-mid" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.36 6.64A9 9 0 1 1 5.64 19.36M1 1l22 22M8.5 16.5a5 5 0 0 1 7 0" />
        </svg>
      </div>
      <h1 class="text-xl font-semibold">{{ heading }}</h1>
      <p class="text-sm text-mid">
        You have no connection right now. You can still write shift notes — they're
        saved on this device and sync automatically the moment you reconnect.
      </p>
      <router-link to="/shifts/new" class="btn-primary inline-block">+ Write a shift note</router-link>
    </div>

    <div v-if="drafts.length" class="card">
      <h3 class="font-semibold mb-3">{{ drafts.length }} note{{ drafts.length === 1 ? '' : 's' }} waiting to sync</h3>
      <ul class="space-y-2">
        <li v-for="d in drafts" :key="d.id" class="text-sm flex items-center justify-between gap-2">
          <span class="truncate min-w-0">{{ d.shiftDate || 'Shift note' }}</span>
          <span class="text-xs text-mid whitespace-nowrap shrink-0">saved {{ (d.savedAt || '').slice(0, 16).replace('T', ' ') }}</span>
        </li>
      </ul>
      <p class="text-xs text-mid mt-3">These stay on this device only until they sync.</p>
    </div>
  </div>
</template>
