<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Toast from './components/Toast.vue'
import OfflineIndicator from './components/OfflineIndicator.vue'
import ServerSetupPage from './pages/ServerSetupPage.vue'
import { isNativeApp, serverBase, serverSetupOpen } from './composables/serverBase.js'

// The offline-capture indicator is a staff-only feature — never show it in the
// participant portal (which has no offline mode).
const route = useRoute()
const inPortal = computed(() => !!route.meta.portal)

// Native app with no server configured yet (or the user asked to change it):
// show the server-setup screen instead of the app.
const showServerSetup = computed(() => serverSetupOpen.value || (isNativeApp() && !serverBase()))
</script>

<template>
  <ServerSetupPage v-if="showServerSetup" />
  <template v-else>
    <router-view />
    <Toast />
    <OfflineIndicator v-if="!inPortal" />
  </template>
</template>
