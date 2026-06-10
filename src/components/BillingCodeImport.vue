<script setup>
import { ref } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const emit = defineEmits(['imported'])
const api = useApi()
const toast = useToastStore()

const rows = ref([])
const warning = ref('')
const version = ref('')
const deactivateMissing = ref(false)
const busy = ref(false)
const fileInput = ref(null)

async function parse (event) {
  const file = event.target.files?.[0]
  if (!file) return
  busy.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    const res = await api.upload('/billing-codes/import', form)
    rows.value = res.data.rows
    warning.value = res.data.warning || ''
    toast.push(`Parsed ${res.data.rows.length} support items — review before committing`, 'success')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function commit () {
  if (!version.value) { toast.push('Enter the price guide version (e.g. 2024-25 v1.4)', 'warning'); return }
  busy.value = true
  try {
    const res = await api.post('/billing-codes/import/commit', {
      price_guide_version: version.value,
      deactivate_missing: deactivateMissing.value ? 1 : 0,
      rows: rows.value.map(({ confidence, ...r }) => r)
    })
    toast.push(`Import complete: ${res.data.inserted} new, ${res.data.updated} updated, ${res.data.deactivated} deactivated`, 'success')
    rows.value = []
    emit('imported')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card space-y-4">
    <div>
      <h3 class="font-semibold">Import NDIS price guide</h3>
      <p class="text-xs text-mid mt-1">Upload the official Pricing Arrangements as <strong>.docx (preferred)</strong> or PDF (less reliable). Parsing is fully local — nothing is sent to the Claude API. Review the rows, then commit.</p>
    </div>
    <label class="btn-ghost cursor-pointer w-fit">
      <input ref="fileInput" type="file" accept=".docx,.pdf" class="hidden" @change="parse" />
      {{ busy && !rows.length ? 'Parsing…' : 'Choose .docx / .pdf' }}
    </label>
    <p v-if="warning" class="text-sm text-warning">{{ warning }}</p>

    <template v-if="rows.length">
      <div class="flex flex-wrap items-center gap-3">
        <input v-model="version" class="input max-w-xs" placeholder="Price guide version, e.g. 2025-26 v1.0" />
        <label class="flex items-center gap-2 text-sm"><input v-model="deactivateMissing" type="checkbox" class="accent-warning" /> Deactivate items missing from this guide</label>
        <button class="btn-primary" :disabled="busy" @click="commit">Commit {{ rows.length }} items</button>
      </div>
      <div class="overflow-x-auto max-h-96 border border-white/10 rounded-xl">
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-surface">
            <tr class="text-left text-mid border-b border-white/10">
              <th class="p-2">Code</th><th class="p-2">Name</th><th class="p-2">Unit</th><th class="p-2">Standard</th><th class="p-2">Remote</th><th class="p-2">V.Remote</th><th class="p-2">Quote</th><th class="p-2">Confidence</th><th class="p-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.code + i" class="border-b border-white/5" :class="r.confidence === 'low' ? 'bg-warning/5' : ''">
              <td class="p-2 font-mono">{{ r.code }}</td>
              <td class="p-2"><input v-model="r.name" class="input !py-1 !text-xs min-w-48" /></td>
              <td class="p-2">{{ r.unit }}</td>
              <td class="p-2"><input v-model.number="r.price_cap_standard" type="number" step="0.01" class="input !py-1 !text-xs w-20" /></td>
              <td class="p-2">{{ r.price_cap_remote ?? '—' }}</td>
              <td class="p-2">{{ r.price_cap_very_remote ?? '—' }}</td>
              <td class="p-2">{{ r.quote_required ? 'yes' : '' }}</td>
              <td class="p-2" :class="r.confidence === 'low' ? 'text-warning' : 'text-mid'">{{ r.confidence }}</td>
              <td class="p-2"><button class="text-danger hover:underline" @click="rows.splice(i, 1)">drop</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
