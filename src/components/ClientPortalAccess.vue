<script setup>
import { ref, onMounted, computed } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * Admin panel to manage a participant's client-portal login: grant access
 * (username + password), rename, reset the password, activate/deactivate, or
 * remove it. The portal itself is participant-facing at /portal; this only
 * manages the credential. Disabled in demo mode (the server blocks the writes).
 */
const props = defineProps({ clientId: { type: [Number, String], required: true } })

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const account = ref(null)
const loading = ref(true)
const username = ref('')
const password = ref('')
const active = ref(true)
const saving = ref(false)
const resetPw = ref('')
const confirmRemove = ref(false)

const hasAccount = computed(() => !!account.value)
const portalUrl = computed(() => `${window.location.origin}/portal/login`)

async function load () {
  loading.value = true
  try {
    const res = await api.get(`/clients/${props.clientId}/portal-account`)
    account.value = res.data
    if (account.value) {
      username.value = account.value.username
      active.value = account.value.active
    }
  } finally {
    loading.value = false
  }
}

async function save () {
  saving.value = true
  try {
    const body = { username: username.value, active: active.value ? 1 : 0 }
    if (password.value) body.password = password.value
    const res = await api.put(`/clients/${props.clientId}/portal-account`, body)
    account.value = res.data
    password.value = ''
    toast.push('Portal access saved', 'success')
  } catch { /* toast surfaced by the interceptor */ } finally {
    saving.value = false
  }
}

async function doResetPassword () {
  if (!resetPw.value) return
  saving.value = true
  try {
    await api.post(`/clients/${props.clientId}/portal-account/password`, { new_password: resetPw.value })
    resetPw.value = ''
    toast.push('Portal password reset', 'success')
  } catch { /* handled */ } finally {
    saving.value = false
  }
}

async function remove () {
  confirmRemove.value = false
  try {
    await api.del(`/clients/${props.clientId}/portal-account`)
    account.value = null
    username.value = ''
    password.value = ''
    active.value = true
    toast.push('Portal access removed', 'success')
  } catch { /* handled */ }
}

function niceDateTime (iso) {
  if (!iso) return 'never'
  try { return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="card">
      <h3 class="font-semibold mb-1">Client portal access</h3>
      <p class="text-sm text-mid mb-4">
        Grant this participant a read-only login to the
        <a :href="portalUrl" target="_blank" rel="noopener" class="text-accent hover:underline">participant portal</a>,
        where they can view their finalised shift notes and completed documents. They never see billing, incident detail, or other participants.
      </p>

      <p v-if="loading" class="text-sm text-mid">Loading…</p>

      <template v-else>
        <div v-if="hasAccount" class="mb-4 rounded-xl border border-white/10 bg-deep/40 p-3 text-sm space-y-1">
          <p><span class="text-mid">Status:</span>
            <span :class="account.active ? 'text-success' : 'text-danger'">{{ account.active ? 'Active' : 'Deactivated' }}</span>
          </p>
          <p><span class="text-mid">Last sign-in:</span> {{ niceDateTime(account.last_login_at) }}</p>
        </div>

        <div class="space-y-3">
          <div>
            <label class="label" for="portal-username">Username</label>
            <input id="portal-username" v-model="username" class="input max-w-xs" :disabled="auth.isDemo" autocomplete="off" />
          </div>
          <div>
            <label class="label" for="portal-password">{{ hasAccount ? 'New password (leave blank to keep)' : 'Password' }}</label>
            <input id="portal-password" v-model="password" type="password" class="input max-w-xs" :disabled="auth.isDemo" autocomplete="new-password" placeholder="At least 10 characters" />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="active" type="checkbox" :disabled="auth.isDemo" /> Access enabled
          </label>
          <div class="flex flex-wrap gap-2 pt-1">
            <button class="btn-primary" :disabled="saving || auth.isDemo || !username" @click="save">
              {{ hasAccount ? 'Save changes' : 'Create portal login' }}
            </button>
            <button v-if="hasAccount" class="btn-danger" :disabled="auth.isDemo" @click="confirmRemove = true">Remove access</button>
          </div>
          <p v-if="auth.isDemo" class="text-xs text-mid">Portal-account changes are disabled in the demo.</p>
        </div>
      </template>
    </div>

    <div v-if="hasAccount && !loading" class="card">
      <h3 class="font-semibold mb-1">Reset password</h3>
      <p class="text-sm text-mid mb-3">Set a new password and share it with the participant securely. This signs them out of any active portal session.</p>
      <div class="flex flex-wrap items-end gap-2">
        <div>
          <label class="label" for="portal-reset">New password</label>
          <input id="portal-reset" v-model="resetPw" type="password" class="input max-w-xs" :disabled="auth.isDemo" autocomplete="new-password" placeholder="At least 10 characters" />
        </div>
        <button class="btn-ghost" :disabled="saving || auth.isDemo || !resetPw" @click="doResetPassword">Reset password</button>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmRemove"
      title="Remove portal access?"
      message="The participant will no longer be able to sign in to the portal. Their notes and documents are unaffected. You can grant access again later."
      confirm-label="Remove access"
      danger
      @confirm="remove"
      @cancel="confirmRemove = false"
    />
  </div>
</template>
