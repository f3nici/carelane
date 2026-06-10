<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import AgreementEditor from '../components/AgreementEditor.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const id = computed(() => route.params.id)

const name = ref('')
const templateType = ref('agreement')
const reportType = ref('')
const description = ref('')
const body = ref('')
const isDefault = ref(false)
const active = ref(true)
const busy = ref(false)
const confirmDelete = ref(false)

onMounted(async () => {
  if (id.value) {
    const res = await api.get(`/templates/${id.value}`)
    const t = res.data
    name.value = t.name
    templateType.value = t.template_type
    reportType.value = t.report_type || ''
    description.value = t.description || ''
    body.value = t.body_markdown || ''
    isDefault.value = !!t.is_default
    active.value = !!t.active
  }
})

function payload () {
  return {
    name: name.value,
    template_type: templateType.value,
    report_type: templateType.value === 'report' ? (reportType.value || null) : null,
    description: description.value || null,
    body_markdown: body.value,
    is_default: isDefault.value ? 1 : 0,
    active: active.value ? 1 : 0
  }
}

async function save () {
  if (!name.value.trim()) { toast.push('Give the template a name', 'warning'); return }
  if (!body.value.trim()) { toast.push('Add the template body', 'warning'); return }
  busy.value = true
  try {
    const res = id.value ? await api.put(`/templates/${id.value}`, payload()) : await api.post('/templates', payload())
    toast.push('Template saved', 'success')
    if (!id.value) router.replace(`/templates/${res.data.id}`)
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function remove () {
  confirmDelete.value = false
  await api.del(`/templates/${id.value}`)
  toast.push('Template deleted', 'success')
  router.replace('/templates')
}
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ id ? 'Template' : 'New template' }}</h1>
      <button v-if="id" class="btn-ghost text-danger" @click="confirmDelete = true">Delete</button>
    </div>

    <div class="card">
      <div class="grid sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2"><label class="label">Name</label><input v-model="name" class="input" placeholder="e.g. Standard service agreement" /></div>
        <div>
          <label class="label">Type</label>
          <select v-model="templateType" class="input">
            <option value="agreement">Agreement</option>
            <option value="report">Report</option>
          </select>
        </div>
        <div v-if="templateType === 'report'">
          <label class="label">Report type</label>
          <select v-model="reportType" class="input">
            <option value="">Any report</option>
            <option v-for="r in ['progress', 'plan_review', 'incident', 'general']" :key="r" :value="r">{{ r.replace('_', ' ') }}</option>
          </select>
        </div>
        <div class="sm:col-span-2"><label class="label">Description</label><input v-model="description" class="input" placeholder="When to use this template (optional)" /></div>
        <label class="flex items-center gap-2 text-sm"><input v-model="isDefault" type="checkbox" class="accent-primary" /> Use as default for this type</label>
        <label class="flex items-center gap-2 text-sm"><input v-model="active" type="checkbox" class="accent-primary" /> Active</label>
      </div>
    </div>

    <div>
      <label class="label">Template body</label>
      <p class="text-xs text-mid mb-2">Write the headings and any fixed house wording. Claude keeps this structure and fills each section when drafting — it does not invent terms.</p>
      <AgreementEditor v-model="body" />
    </div>

    <button class="btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save template' }}</button>

    <ConfirmDialog
      :open="confirmDelete"
      title="Delete this template?"
      message="It will no longer be available when drafting. Existing documents are unaffected."
      confirm-label="Delete"
      @confirm="remove"
      @cancel="confirmDelete = false"
    />
  </div>
</template>
