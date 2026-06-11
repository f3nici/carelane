<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgreementListPage from './AgreementListPage.vue'
import ReportListPage from './ReportListPage.vue'
import TemplateListPage from './TemplateListPage.vue'

const route = useRoute()
const router = useRouter()

const tabs = [
  { key: 'agreements', label: 'Agreements' },
  { key: 'reports', label: 'Reports' },
  { key: 'templates', label: 'Templates' }
]

const tab = ref(tabs.some(t => t.key === route.query.tab) ? route.query.tab : 'agreements')

function setTab (key) {
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
}
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
    <TemplateListPage v-else />
  </div>
</template>
