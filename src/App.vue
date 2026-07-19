<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Toast from './components/Toast.vue'
import OfflineIndicator from './components/OfflineIndicator.vue'

// The offline-capture indicator is a staff-only feature — never show it in the
// participant portal (which has no offline mode).
const route = useRoute()
const inPortal = computed(() => !!route.meta.portal)
</script>

<template>
  <router-view />
  <Toast />
  <OfflineIndicator v-if="!inPortal" />
</template>
