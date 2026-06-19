<script setup>
import { computed, onMounted } from 'vue'
import { useOfflineStore } from '../stores/offline.js'

const offline = useOfflineStore()

onMounted(() => offline.init())

// Show only when there's something to say: offline, or drafts waiting to sync.
const visible = computed(() => offline.supported && (!offline.online || offline.pending > 0))
</script>

<template>
  <div
    v-if="visible"
    class="fixed z-40 bottom-20 md:bottom-6 left-4 md:left-auto md:right-6 max-w-xs"
  >
    <div
      class="rounded-xl border px-3 py-2 text-sm shadow-lg flex items-center gap-3 backdrop-blur"
      :class="offline.online ? 'bg-surface/95 border-warning/40 text-warning' : 'bg-surface/95 border-white/15 text-mid'"
    >
      <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path v-if="!offline.online" stroke-linecap="round" stroke-linejoin="round" d="M18.36 6.64A9 9 0 1 1 5.64 19.36M1 1l22 22M8.5 16.5a5 5 0 0 1 7 0" />
        <path v-else stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <div class="min-w-0 flex-1">
        <p v-if="!offline.online" class="font-medium text-white">Offline</p>
        <p class="text-xs">
          <template v-if="offline.pending">{{ offline.pending }} note{{ offline.pending === 1 ? '' : 's' }} waiting to sync</template>
          <template v-else>Notes you save will sync when you reconnect.</template>
        </p>
      </div>
      <button
        v-if="offline.online && offline.pending"
        class="text-accent text-xs hover:underline shrink-0"
        :disabled="offline.syncing"
        @click="offline.flush({ silent: false })"
      >{{ offline.syncing ? 'Syncing…' : 'Sync now' }}</button>
    </div>
  </div>
</template>
