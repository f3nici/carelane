<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import ClientForm from '../components/ClientForm.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const client = ref({})
const busy = ref(false)
const id = route.params.id

onMounted(async () => {
  if (id) {
    const res = await api.get(`/clients/${id}`)
    client.value = res.data
  }
})

async function save (payload) {
  busy.value = true
  try {
    const res = id ? await api.put(`/clients/${id}`, payload) : await api.post('/clients', payload)
    toast.push('Client saved', 'success')
    router.push(`/clients/${res.data.id}`)
  } catch { /* toast shown by interceptor */ } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4 max-w-4xl">
    <h1 class="text-2xl font-semibold">{{ id ? 'Edit client' : 'New client' }}</h1>
    <ClientForm :model-value="client" :busy="busy" @submit="save" />
  </div>
</template>
