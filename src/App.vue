<script setup>
import Toast from './components/Toast.vue'
import OfflineIndicator from './components/OfflineIndicator.vue'
</script>

<template>
  <router-view />
  <Toast />
  <OfflineIndicator />
</template>
