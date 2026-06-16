<script setup>
import { ref } from 'vue'
import AppSidebar from '../components/AppSidebar.vue'
import QuickSwitcher from '../components/QuickSwitcher.vue'

const switcher = ref(null)
</script>

<template>
  <div class="min-h-screen md:flex">
    <AppSidebar @open-search="switcher?.show()" />
    <main class="flex-1 min-w-0 p-4 md:p-8 pt-[4.5rem] md:pt-8">
      <router-view />
    </main>
    <QuickSwitcher ref="switcher" />
  </div>
</template>
