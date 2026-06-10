<script setup>
import AppSidebar from '../components/AppSidebar.vue'
</script>

<template>
  <div class="min-h-screen md:flex">
    <AppSidebar />
    <main class="flex-1 min-w-0 p-4 md:p-8 pb-24 md:pb-8">
      <router-view />
    </main>
  </div>
</template>
