<script setup>
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'

const api = useApi()
const toast = useToastStore()

const freshness = ref(null)
const backups = ref([])
const verifying = ref('')
const verified = ref({}) // filename -> result
const busy = ref(false)
const loadError = ref(false)

onMounted(load)

async function load () {
  try {
    const res = await api.get('/settings/backups')
    freshness.value = res.data.freshness
    backups.value = res.data.backups
  } catch {
    loadError.value = true // non-admins cannot view backups
  }
}

async function runNow () {
  busy.value = true
  try {
    await api.post('/settings/backups/run')
    toast.push('Backup created', 'success')
    await load()
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function verify (file) {
  verifying.value = file
  try {
    const res = await api.get(`/settings/backups/${file}/verify`)
    verified.value = { ...verified.value, [file]: res.data }
  } catch { /* toast via interceptor */ } finally {
    verifying.value = ''
  }
}

function formatSize (bytes) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div v-if="!loadError" class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold">Backups</h3>
      <button class="btn-ghost text-sm" :disabled="busy" @click="runNow">{{ busy ? 'Backing up…' : 'Back up now' }}</button>
    </div>

    <div v-if="freshness" class="text-sm">
      <p v-if="!freshness.enabled" class="text-mid">Automatic backups are disabled (<code>BACKUP_ENABLED=false</code>).</p>
      <p v-else-if="freshness.stale" class="text-warning">
        ⚠ {{ freshness.count === 0 ? 'No backups yet — the first nightly backup has not run.' : `Latest backup is ${freshness.age_hours}h old.` }}
      </p>
      <p v-else class="text-success">✓ Latest backup {{ freshness.age_hours }}h ago · {{ freshness.count }} snapshot(s) retained.</p>
    </div>

    <ul v-if="backups.length" class="divide-y divide-white/10">
      <li v-for="b in backups" :key="b.db" class="py-2 flex items-center justify-between gap-3 text-sm">
        <div class="min-w-0">
          <p class="font-mono text-xs truncate">{{ b.db }}<span v-if="b.uploads" class="text-mid"> + uploads</span></p>
          <p class="text-xs text-mid">{{ b.created_at.slice(0, 16).replace('T', ' ') }} · {{ formatSize(b.size_bytes) }}
            <span v-if="verified[b.db]" :class="verified[b.db].ok ? 'text-success' : 'text-danger'">
              · integrity {{ verified[b.db].integrity }} ({{ verified[b.db].clients }} clients, {{ verified[b.db].shifts }} shifts)
            </span>
          </p>
        </div>
        <button class="text-accent text-xs hover:underline shrink-0" :disabled="verifying === b.db" @click="verify(b.db)">
          {{ verifying === b.db ? 'checking…' : 'verify' }}
        </button>
      </li>
    </ul>
    <p v-else class="text-sm text-mid">No backups found yet.</p>

    <p class="text-xs text-mid">To restore a snapshot, stop the server and run <code>npm run restore</code> (it verifies integrity and sets the current database aside first). Restoring is intentionally not available over the web.</p>
  </div>
</template>
