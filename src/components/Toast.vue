<script setup>
import { useToastStore } from '../stores/toast.js'

const store = useToastStore()
const styles = {
  info: 'border-info/50 text-info',
  success: 'border-success/50 text-success',
  error: 'border-danger/50 text-danger',
  warning: 'border-warning/50 text-warning'
}
</script>

<template>
  <div class="fixed bottom-20 md:bottom-6 right-4 z-50 space-y-2 max-w-sm">
    <transition-group name="toast">
      <div
        v-for="toast in store.toasts"
        :key="toast.id"
        class="card !p-3 flex items-start gap-2 border text-sm shadow-lg cursor-pointer"
        :class="styles[toast.type] || styles.info"
        @click="store.dismiss(toast.id)"
      >
        <span class="text-white">{{ toast.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px) }
</style>
