<script setup>
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Are you sure?' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  danger: { type: Boolean, default: false }
})

const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" @click.self="emit('cancel')">
      <div class="card max-w-sm w-full">
        <h3 class="font-semibold mb-2">{{ title }}</h3>
        <p class="text-sm text-mid mb-4">{{ message }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost" @click="emit('cancel')">Cancel</button>
          <button :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">{{ confirmLabel }}</button>
        </div>
      </div>
    </div>
  </teleport>
</template>
