<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import { useAuthStore } from '../stores/auth.js'

const api = useApi()
const toast = useToastStore()
const auth = useAuthStore()

const users = ref([])
const loading = ref(true)

// New-member form.
const draft = ref({ username: '', display_name: '', password: '', role: 'worker' })
const creating = ref(false)

// Assignment editor state (open for one worker at a time).
const assignFor = ref(null) // the user being edited
const allClients = ref([])
const selectedClientIds = ref(new Set())
const savingAssign = ref(false)

async function loadUsers () {
  loading.value = true
  try {
    users.value = await api.get('/users').then(r => r.data)
  } finally {
    loading.value = false
  }
}

async function createUser () {
  creating.value = true
  try {
    await api.post('/users', draft.value)
    toast.push('Team member added', 'success')
    draft.value = { username: '', display_name: '', password: '', role: 'worker' }
    await loadUsers()
  } catch { /* interceptor toasts the error */ } finally {
    creating.value = false
  }
}

async function toggleActive (u) {
  try {
    await api.put(`/users/${u.id}`, { active: u.active ? 0 : 1 })
    toast.push(u.active ? 'Login deactivated' : 'Login reactivated', 'success')
    await loadUsers()
  } catch { /* toasted */ }
}

async function changeRole (u, role) {
  try {
    await api.put(`/users/${u.id}`, { role })
    toast.push('Role updated', 'success')
    await loadUsers()
  } catch { await loadUsers() }
}

async function resetPassword (u) {
  const pw = window.prompt(`Set a new password for ${u.display_name} (min 10 characters):`)
  if (!pw) return
  try {
    await api.post(`/users/${u.id}/reset-password`, { new_password: pw })
    toast.push('Password reset — their other sessions were signed out', 'success')
  } catch { /* toasted */ }
}

async function openAssignments (u) {
  assignFor.value = u
  // Load the full participant list (admins see all) and the worker's current set.
  const [clientsRes, current] = await Promise.all([
    api.get('/clients', { per_page: 500 }).then(r => r.data),
    api.get(`/users/${u.id}/clients`).then(r => r.data.client_ids)
  ])
  allClients.value = clientsRes
  selectedClientIds.value = new Set(current)
}

function toggleClient (id) {
  const set = selectedClientIds.value
  if (set.has(id)) set.delete(id); else set.add(id)
  // reassign to trigger reactivity on the Set
  selectedClientIds.value = new Set(set)
}

async function saveAssignments () {
  savingAssign.value = true
  try {
    await api.put(`/users/${assignFor.value.id}/clients`, { client_ids: [...selectedClientIds.value] })
    toast.push('Participant access updated', 'success')
    assignFor.value = null
    await loadUsers()
  } catch { /* toasted */ } finally {
    savingAssign.value = false
  }
}

const workerCount = computed(() => users.value.filter(u => u.role === 'worker').length)

onMounted(loadUsers)
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Team</h1>
        <p class="text-mid text-sm">Manage logins and choose which participants each support worker can see.</p>
      </div>
      <span class="pill bg-white/10 text-mid">{{ workerCount }} support worker{{ workerCount === 1 ? '' : 's' }}</span>
    </div>

    <!-- Add member -->
    <form class="card space-y-3" @submit.prevent="createUser">
      <h2 class="font-semibold">Add a team member</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input v-model="draft.username" class="input" placeholder="Username" autocomplete="off" required />
        <input v-model="draft.display_name" class="input" placeholder="Display name" required />
        <input v-model="draft.password" type="password" class="input" placeholder="Initial password (min 10)" autocomplete="new-password" required />
        <select v-model="draft.role" class="input">
          <option value="worker">Support worker</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="flex justify-end">
        <button class="btn-primary" :disabled="creating">{{ creating ? 'Adding…' : '+ Add member' }}</button>
      </div>
    </form>

    <!-- Members -->
    <p v-if="loading" class="text-mid text-sm">Loading…</p>
    <div v-else class="space-y-3">
      <div v-for="u in users" :key="u.id" class="card flex flex-wrap items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="font-medium truncate">
            {{ u.display_name }}
            <span v-if="u.id === auth.user?.id" class="text-mid text-xs">(you)</span>
            <span v-if="!u.active" class="pill bg-red-500/20 text-red-300 ml-1">deactivated</span>
          </p>
          <p class="text-mid text-xs truncate">@{{ u.username }} · {{ u.assigned_client_count }} participant{{ u.assigned_client_count === 1 ? '' : 's' }}</p>
        </div>
        <select
          class="input w-auto text-sm"
          :value="u.role"
          @change="changeRole(u, $event.target.value)"
        >
          <option value="worker">Support worker</option>
          <option value="admin">Admin</option>
        </select>
        <button v-if="u.role === 'worker'" class="btn-ghost text-sm" @click="openAssignments(u)">Clients</button>
        <button class="btn-ghost text-sm" @click="resetPassword(u)">Reset password</button>
        <button class="btn-ghost text-sm" :disabled="u.id === auth.user?.id" @click="toggleActive(u)">
          {{ u.active ? 'Deactivate' : 'Reactivate' }}
        </button>
      </div>
    </div>

    <!-- Assignment editor -->
    <div v-if="assignFor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="assignFor = null">
      <div class="card w-full max-w-lg max-h-[80vh] flex flex-col">
        <h2 class="font-semibold mb-1">Participants for {{ assignFor.display_name }}</h2>
        <p class="text-mid text-xs mb-3">They can view (but not edit) everything for the participants you tick, and see only their own roster.</p>
        <div class="flex-1 overflow-y-auto space-y-1 pr-1">
          <p v-if="!allClients.length" class="text-mid text-sm">No participants yet.</p>
          <label
            v-for="c in allClients"
            :key="c.id"
            class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5 cursor-pointer"
          >
            <input type="checkbox" :checked="selectedClientIds.has(c.id)" @change="toggleClient(c.id)" />
            <span class="truncate">{{ c.preferred_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || ('Client #' + c.id) }}</span>
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-3">
          <button class="btn-ghost" @click="assignFor = null">Cancel</button>
          <button class="btn-primary" :disabled="savingAssign" @click="saveAssignments">{{ savingAssign ? 'Saving…' : 'Save access' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
