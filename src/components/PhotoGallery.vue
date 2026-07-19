<script setup>
import { useApi } from '../composables/useApi.js'
import { apiUrl } from '../composables/serverBase.js'

const props = defineProps({
  shiftId: { type: [Number, String], required: true },
  photos: { type: Array, default: () => [] }
})
const emit = defineEmits(['deleted'])

const api = useApi()

// media files are served only via this auth-gated endpoint, never a static path
const mediaUrl = id => apiUrl(`/api/v1/shifts/${props.shiftId}/photos/${id}/file`)
const isVideo = mime => typeof mime === 'string' && mime.startsWith('video/')

async function remove (id) {
  await api.del(`/shifts/${props.shiftId}/photos/${id}`)
  emit('deleted', id)
}
</script>

<template>
  <div v-if="photos.length" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
    <figure v-for="p in photos" :key="p.id" class="relative group rounded-xl overflow-hidden border border-white/10">
      <video
        v-if="isVideo(p.mime_type)"
        :src="mediaUrl(p.id)"
        controls
        preload="metadata"
        class="h-32 w-full object-cover bg-black"
      />
      <img v-else :src="mediaUrl(p.id)" :alt="p.caption || p.original_name" class="h-32 w-full object-cover" loading="lazy" />
      <figcaption v-if="p.caption" class="text-xs text-mid p-1.5 bg-surface truncate">{{ p.caption }}</figcaption>
      <button class="absolute top-1.5 right-1.5 hidden group-hover:block bg-black/70 text-danger text-xs rounded-lg px-2 py-1" @click="remove(p.id)">Delete</button>
    </figure>
  </div>
  <p v-else class="text-sm text-mid">No photos or videos attached.</p>
</template>
