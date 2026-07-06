<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useIntegrations } from '../composables/useIntegrations.js'
import { useToastStore } from '../stores/toast.js'
import BrandingSettings from '../components/BrandingSettings.vue'
import PasswordSettings from '../components/PasswordSettings.vue'
import TwoFactorSettings from '../components/TwoFactorSettings.vue'
import PasskeySettings from '../components/PasskeySettings.vue'
import SecurityPolicySettings from '../components/SecurityPolicySettings.vue'
import SessionsSettings from '../components/SessionsSettings.vue'
import BackupSettings from '../components/BackupSettings.vue'
import GoogleCalendarSettings from '../components/GoogleCalendarSettings.vue'
import SquareInvoicingSettings from '../components/SquareInvoicingSettings.vue'
import NtfyNotificationsSettings from '../components/NtfyNotificationsSettings.vue'
import BillingCodesPage from './BillingCodesPage.vue'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { refresh: refreshIntegrations } = useIntegrations()
const settings = ref(null)

// Billing-code maintenance is an admin tool; workers only get the (self-service)
// general settings.
const tabs = auth.isAdmin
  ? [{ key: 'general', label: 'General' }, { key: 'billing', label: 'Billing codes' }]
  : [{ key: 'general', label: 'General' }]
const tab = ref(tabs.some(t => t.key === route.query.tab) ? route.query.tab : 'general')

function setTab (key) {
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
}

// Collapsible categories so the long settings list isn't one giant scroll.
// Security opens automatically when the operator is being funnelled here to
// enrol a second factor.
const needsEnrol = auth.mustEnrol2fa || route.query.enrol === '2fa'
const open = ref({
  business: !needsEnrol,
  security: needsEnrol,
  integrations: false,
  data: false
})
function toggle (key) { open.value[key] = !open.value[key] }

// Claude API integration (key is an env secret; only the model ids are stored).
const aiStatus = ref(null)
const aiBusy = ref(false)
const aiTestResult = ref(null)

onMounted(async () => {
  // Business/integration settings are admin-only on the server; a support worker
  // only uses this page for their own password / 2FA / passkeys / sessions.
  if (!auth.isAdmin) return
  const [res, ai] = await Promise.all([
    api.get('/settings'),
    api.get('/settings/ai/status')
  ])
  settings.value = res.data
  aiStatus.value = ai.data
  // Older databases predate the claude_enabled setting — seed the checkbox from
  // the server's resolved status (which defaults to on) so it round-trips.
  if (settings.value.claude_enabled === undefined) settings.value.claude_enabled = ai.data.enabled ? 1 : 0
})

async function save () {
  await api.put('/settings', settings.value)
  toast.push('Settings saved', 'success')
  // Refresh the app-wide AI gate so the draft panels / tips appear or disappear
  // immediately when Claude is switched on or off here.
  await refreshIntegrations()
}

async function testAi () {
  aiBusy.value = true
  aiTestResult.value = null
  try {
    const res = await api.post('/settings/ai/test', {})
    aiTestResult.value = res.data
    if (res.data.ok) toast.push('Claude reachable', 'success')
    else toast.push(res.data.error || 'Test failed', 'error')
  } catch { /* */ } finally { aiBusy.value = false }
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

    <BillingCodesPage v-if="tab === 'billing'" />

    <div v-else class="space-y-4 max-w-3xl">
    <h1 class="text-2xl font-semibold">Settings</h1>

    <div v-if="auth.mustEnrol2fa" class="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-1">
      <p class="text-sm font-medium text-warning">Set up a second factor to continue</p>
      <p class="text-xs text-mid">Your administrator requires two-factor authentication or a passkey on every account. Enable one below to unlock the rest of the app.</p>
    </div>

    <!-- Business & branding (admin only) -->
    <section v-if="auth.isAdmin && settings" class="rounded-xl border border-white/10 overflow-hidden">
      <button class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors" @click="toggle('business')">
        <span class="font-semibold">Business &amp; branding</span>
        <svg class="h-5 w-5 text-mid shrink-0 transition-transform" :class="open.business ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </button>
      <div v-show="open.business" class="border-t border-white/10 p-5 space-y-6">
        <BrandingSettings :settings="settings" @save="save" />
      </div>
    </section>

    <!-- Security & access -->
    <section class="rounded-xl border border-white/10 overflow-hidden">
      <button class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors" @click="toggle('security')">
        <span class="font-semibold">Security &amp; access</span>
        <svg class="h-5 w-5 text-mid shrink-0 transition-transform" :class="open.security ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </button>
      <div v-show="open.security" class="border-t border-white/10 p-5 space-y-6">
        <div v-if="auth.isDemo" class="rounded-xl border border-accent/40 bg-accent/10 p-4 space-y-1">
          <p class="text-sm font-medium text-accent">Account security is disabled in the demo</p>
          <p class="text-xs text-mid">Changing the password, two-factor authentication or passkeys is turned off so the shared demo login can't be locked for other visitors. These controls work normally on a real install.</p>
        </div>
        <template v-else>
          <PasswordSettings />
          <TwoFactorSettings />
          <PasskeySettings />
          <SecurityPolicySettings />
        </template>
        <SessionsSettings />
      </div>
    </section>

    <!-- Integrations (admin only) -->
    <section v-if="auth.isAdmin && settings" class="rounded-xl border border-white/10 overflow-hidden">
      <button class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors" @click="toggle('integrations')">
        <span class="font-semibold">Integrations</span>
        <svg class="h-5 w-5 text-mid shrink-0 transition-transform" :class="open.integrations ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </button>
      <div v-show="open.integrations" class="border-t border-white/10 p-5 space-y-6">
        <div v-if="aiStatus" class="card space-y-4">
          <div class="flex items-center justify-between gap-3">
            <h3 class="font-semibold">Claude AI</h3>
            <span v-if="aiStatus.configured && settings.claude_enabled" class="pill bg-success/15 text-success">On</span>
            <span v-else-if="aiStatus.configured" class="pill bg-white/10 text-mid">Off</span>
            <span v-else class="pill bg-white/10 text-mid">Not configured</span>
          </div>
          <p class="text-xs text-mid">Claude drafts shift notes, reports and agreements — output is always a draft you review. The API key is set via the <code>ANTHROPIC_API_KEY</code> environment variable, never stored here. Model IDs are configurable so they can be upgraded without a code change.</p>
          <p v-if="!aiStatus.configured" class="text-sm text-warning">Not configured. Add an Anthropic API key to the server environment to enable AI drafting.</p>
          <label class="flex items-center gap-2 text-sm"><input v-model="settings.claude_enabled" type="checkbox" :true-value="1" :false-value="0" :disabled="!aiStatus.configured" class="accent-accent" /> Enable AI drafting (shift notes, reports, agreements, grounded Q&amp;A)</label>
          <div class="grid sm:grid-cols-2 gap-4">
            <div><label class="label">Cheap model (notes, condensing)</label><input v-model="settings.claude_model_cheap" class="input font-mono text-xs" /></div>
            <div><label class="label">Quality model (agreements, reports)</label><input v-model="settings.claude_model_quality" class="input font-mono text-xs" /></div>
            <div class="sm:col-span-2"><label class="label">Writing tone</label><input v-model="settings.ai_tone" class="input" /></div>
          </div>
          <p v-if="aiTestResult" :class="aiTestResult.ok ? 'text-success text-sm' : 'text-danger text-sm'">
            <template v-if="aiTestResult.ok">Connection OK — model “{{ aiTestResult.model }}” reachable.</template>
            <template v-else>Test failed: {{ aiTestResult.error }}</template>
          </p>
          <div class="flex flex-wrap gap-2">
            <button class="btn-primary" @click="save">Save AI settings</button>
            <button class="btn-ghost" :disabled="aiBusy || !aiStatus.configured" @click="testAi">Test connection</button>
          </div>
        </div>

        <GoogleCalendarSettings />
        <SquareInvoicingSettings />
        <NtfyNotificationsSettings />
      </div>
    </section>

    <!-- Data & privacy (admin only) -->
    <section v-if="auth.isAdmin && settings" class="rounded-xl border border-white/10 overflow-hidden">
      <button class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors" @click="toggle('data')">
        <span class="font-semibold">Data &amp; privacy</span>
        <svg class="h-5 w-5 text-mid shrink-0 transition-transform" :class="open.data ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </button>
      <div v-show="open.data" class="border-t border-white/10 p-5 space-y-6">
        <BackupSettings />
        <div class="card space-y-2">
          <h3 class="font-semibold">Privacy &amp; data</h3>
          <ul class="text-sm text-mid list-disc pl-5 space-y-1">
            <li>Participant PII and note bodies are encrypted at rest (AES-256-GCM) using <code>ENCRYPTION_SECRET</code>. That secret cannot be rotated casually — changing it makes existing data unreadable. Back it up securely.</li>
            <li>Nothing is sent to third parties except the minimal, de-identified context of AI drafting calls you explicitly trigger.</li>
            <li>Regulated records (participants, agreements, shifts, billing) are soft-deleted only, honouring NDIS record retention.</li>
            <li>Nightly database backups run at the configured time with retention applied.</li>
          </ul>
        </div>
        <p class="text-xs text-mid">{{ settings.disclaimer }}</p>
      </div>
    </section>
    </div>
  </div>
</template>
