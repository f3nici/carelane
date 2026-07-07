<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

/**
 * Admin-only panel for creating and managing client-facing share links to ONE
 * finalised report or completed document. A share link is a time-limited,
 * audited, read-only URL a plan manager (or the participant) can open without an
 * account. Embedded on the report detail page and the participant documents tab.
 */
const props = defineProps({
  resourceType: { type: String, required: true }, // 'report' | 'client_document'
  resourceId: { type: [String, Number], required: true },
  clientId: { type: [String, Number], required: true },
  // When false the panel explains why sharing is unavailable (e.g. a draft report).
  shareable: { type: Boolean, default: true },
  unshareableReason: { type: String, default: 'This item cannot be shared yet.' }
})

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const links = ref([])
const loaded = ref(false)
const creating = ref(false)
const form = reactive({ label: '', expires_in_days: 14, max_views: '' })

// Sharing is an operator action; workers and the public demo never see it.
const canShow = computed(() => auth.isAdmin && !auth.isDemo)

async function load () {
  if (!canShow.value) return
  try {
    const res = await api.get('/share-links', { resource_type: props.resourceType, resource_id: props.resourceId })
    links.value = res.data
  } catch { /* toast via interceptor */ } finally {
    loaded.value = true
  }
}
onMounted(load)

async function createLink () {
  creating.value = true
  try {
    const payload = {
      resource_type: props.resourceType,
      resource_id: Number(props.resourceId),
      client_id: Number(props.clientId),
      label: form.label.trim() || null,
      expires_in_days: Number(form.expires_in_days) || 14
    }
    if (form.max_views) payload.max_views = Number(form.max_views)
    const res = await api.post('/share-links', payload)
    links.value = [res.data, ...links.value]
    form.label = ''
    form.max_views = ''
    await copy(res.data.url)
    toast.push('Share link created and copied to clipboard', 'success')
  } catch { /* toast via interceptor */ } finally {
    creating.value = false
  }
}

async function revoke (link) {
  const res = await api.post(`/share-links/${link.id}/revoke`, {})
  links.value = links.value.map(l => l.id === res.data.id ? res.data : l)
  toast.push('Share link revoked', 'success')
}

async function copy (url) {
  try {
    await navigator.clipboard.writeText(url)
    toast.push('Link copied', 'success')
  } catch { /* clipboard blocked — the URL is shown for manual copy */ }
}

const stateLabel = { active: 'Active', expired: 'Expired', revoked: 'Revoked', exhausted: 'View limit reached' }
const stateClass = s => s === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/10 text-mid'

function niceDate (iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return iso }
}
</script>

<template>
  <div v-if="canShow" class="card">
    <div class="flex items-center justify-between mb-2 gap-3 flex-wrap">
      <h3 class="font-semibold">Client share links</h3>
    </div>
    <p class="text-xs text-mid mb-3">
      Create a private, time-limited link a plan manager or the participant can open to download this item — no account needed. Every download is counted and recorded in the audit log. Revoke a link at any time.
    </p>

    <div v-if="!shareable" class="rounded-lg bg-white/5 p-3 text-sm text-mid">{{ unshareableReason }}</div>

    <template v-else>
      <div class="grid sm:grid-cols-4 gap-3 mb-3 rounded-lg bg-white/5 p-3">
        <div class="sm:col-span-2">
          <label class="label">Label (optional)</label>
          <input v-model="form.label" class="input" placeholder="e.g. Plan manager – June" maxlength="200" />
        </div>
        <div>
          <label class="label">Expires in (days)</label>
          <input v-model="form.expires_in_days" type="number" min="1" max="365" class="input" />
        </div>
        <div>
          <label class="label">Max downloads</label>
          <input v-model="form.max_views" type="number" min="1" max="10000" class="input" placeholder="unlimited" />
        </div>
      </div>
      <button class="btn-primary" :disabled="creating" @click="createLink">{{ creating ? 'Creating…' : 'Create share link' }}</button>

      <p v-if="loaded && !links.length" class="text-sm text-mid mt-4">No share links yet.</p>
      <ul v-else class="divide-y divide-white/10 mt-4">
        <li v-for="l in links" :key="l.id" class="py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm flex items-center gap-2 flex-wrap">
                <span class="pill" :class="stateClass(l.state)">{{ stateLabel[l.state] || l.state }}</span>
                <span v-if="l.label" class="truncate">{{ l.label }}</span>
              </p>
              <p class="text-xs text-mid mt-1">
                Expires {{ niceDate(l.expires_at) }}
                · {{ l.view_count }}<span v-if="l.max_views"> / {{ l.max_views }}</span> download{{ l.view_count === 1 ? '' : 's' }}
                <span v-if="l.last_viewed_at"> · last opened {{ niceDate(l.last_viewed_at) }}</span>
              </p>
              <p v-if="l.state === 'active'" class="text-xs text-accent break-all mt-1">{{ l.url }}</p>
            </div>
            <div class="flex gap-3 shrink-0 text-xs">
              <button v-if="l.state === 'active'" class="text-accent hover:underline" @click="copy(l.url)">copy</button>
              <button v-if="!l.revoked_at" class="text-danger hover:underline" @click="revoke(l)">revoke</button>
            </div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
