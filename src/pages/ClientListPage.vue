<script setup>
import { ref, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi.js'
import ClientCard from '../components/ClientCard.vue'

const api = useApi()
const clients = ref([])
const meta = ref({})
const q = ref('')
const page = ref(1)
let debounce = null

async function load () {
  const res = await api.get('/clients', { q: q.value || undefined, page: page.value, per_page: 24 })
  clients.value = res.data
  meta.value = res.meta
}

watch(q, () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { page.value = 1; load() }, 300)
})
watch(page, load)
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">Clients</h1>
      <router-link to="/clients/new" class="btn-primary">+ New client</router-link>
    </div>
    <input v-model="q" class="input max-w-md" placeholder="Search preferred name, suburb, postcode or NDIS number…" />
    <p v-if="!clients.length" class="text-mid text-sm">No clients found.</p>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <ClientCard v-for="c in clients" :key="c.id" :client="c" />
    </div>
    <div v-if="meta.total_pages > 1" class="flex items-center gap-3 text-sm">
      <button class="btn-ghost" :disabled="page <= 1" @click="page--">Previous</button>
      <span class="text-mid">Page {{ meta.page }} of {{ meta.total_pages }}</span>
      <button class="btn-ghost" :disabled="page >= meta.total_pages" @click="page++">Next</button>
    </div>
  </div>
</template>
