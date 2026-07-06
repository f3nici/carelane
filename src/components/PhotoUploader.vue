<script setup>
import { ref } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const props = defineProps({
  shiftId: { type: [Number, String], required: true }
})
const emit = defineEmits(['uploaded'])

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()
const busy = ref(false)
const caption = ref('')
const fileInput = ref(null)

async function upload (event) {
  const file = event.target.files?.[0]
  if (!file) return
  busy.value = true
  try {
    const form = new FormData()
    form.append('photo', file)
    if (caption.value) form.append('caption', caption.value)
    const res = await api.upload(`/shifts/${props.shiftId}/photos`, form)
    emit('uploaded', res.data)
    caption.value = ''
    toast.push('File uploaded', 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <template v-if="!auth.isDemo">
      <input v-model="caption" class="input max-w-xs" placeholder="Caption (optional)" />
      <label class="btn-ghost cursor-pointer">
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/3gpp" class="hidden" @change="upload" />
        {{ busy ? 'Uploading…' : '+ Add photo / video' }}
      </label>
    </template>
    <p v-else class="text-xs text-mid">Photo and video uploads are disabled in the demo.</p>
  </div>
</template>
