<script setup>
import { ref, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const api = useApi()
const templates = ref([])
const meta = ref({})
const page = ref(1)
const templateType = ref('')

const typeLabel = { agreement: 'Agreement', report: 'Report' }

async function load () {
  const res = await api.get('/templates', { page: page.value, per_page: 20, template_type: templateType.value || undefined })
  templates.value = res.data
  meta.value = res.meta
}

watch([page, templateType], load)
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Templates</h1>
        <p class="text-sm text-mid mt-1">Reusable structures Claude follows when drafting agreements and reports.</p>
      </div>
      <router-link to="/templates/new" class="btn-primary">+ New template</router-link>
    </div>
    <select v-model="templateType" class="input max-w-xs">
      <option value="">All types</option>
      <option value="agreement">Agreements</option>
      <option value="report">Reports</option>
    </select>
    <p v-if="!templates.length" class="text-sm text-mid">No templates yet.</p>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <router-link v-for="t in templates" :key="t.id" :to="`/templates/${t.id}`" class="card block hover:border-primary/50 transition-colors">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-semibold truncate">{{ t.name }}</h3>
          <span class="pill bg-white/10 text-mid shrink-0">{{ typeLabel[t.template_type] || t.template_type }}</span>
        </div>
        <p v-if="t.description" class="text-xs text-mid mt-1 line-clamp-2">{{ t.description }}</p>
        <div class="flex items-center gap-2 mt-2 text-xs text-mid">
          <span v-if="t.report_type" class="pill bg-white/10">{{ t.report_type.replace('_', ' ') }}</span>
          <span v-if="t.is_default" class="pill bg-accent/20 text-accent">Default</span>
          <span v-if="!t.active" class="pill bg-white/10">Inactive</span>
        </div>
      </router-link>
    </div>
    <div v-if="meta.total_pages > 1" class="flex items-center gap-3 text-sm">
      <button class="btn-ghost" :disabled="page <= 1" @click="page--">Previous</button>
      <span class="text-mid">Page {{ meta.page }} of {{ meta.total_pages }}</span>
      <button class="btn-ghost" :disabled="page >= meta.total_pages" @click="page++">Next</button>
    </div>
  </div>
</template>
