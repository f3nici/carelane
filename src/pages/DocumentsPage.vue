<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useIntegrations } from '../composables/useIntegrations.js'
import AgreementListPage from './AgreementListPage.vue'
import ReportListPage from './ReportListPage.vue'
import TemplateListPage from './TemplateListPage.vue'

const route = useRoute()
const router = useRouter()
const { aiActive, ensureLoaded } = useIntegrations()

// Templates only exist for Claude to follow when drafting — hide the tab when
// AI drafting is switched off.
const tabs = computed(() => [
  { key: 'agreements', label: 'Agreements' },
  { key: 'reports', label: 'Reports' },
  ...(aiActive.value ? [{ key: 'templates', label: 'Templates' }] : [])
])

const tab = ref(['agreements', 'reports', 'templates'].includes(route.query.tab) ? route.query.tab : 'agreements')

function setTab (key) {
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
}

// Don't strand the operator on (or deep-link them to) the Templates tab once we
// know AI is off — fall back to Agreements.
onMounted(async () => {
  await ensureLoaded()
  if (tab.value === 'templates' && !aiActive.value) setTab('agreements')
})
watch(aiActive, on => { if (!on && tab.value === 'templates') setTab('agreements') })
</script>

<template>
  <div class="space-y-6">
    <div class="flex gap-1 border-b border-white/10 overflow-x-auto">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors"
        :class="tab === t.key ? 'border-primary text-white' : 'border-transparent text-mid hover:text-white'"
        @click="setTab(t.key)"
      >{{ t.label }}</button>
    </div>

    <AgreementListPage v-if="tab === 'agreements'" />
    <ReportListPage v-else-if="tab === 'reports'" />
    <TemplateListPage v-else-if="tab === 'templates' && aiActive" />
  </div>
</template>
