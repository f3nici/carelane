<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'

// Global client quick-switcher. Opens from anywhere with Cmd/Ctrl+K (or the
// sidebar search button) and jumps straight to a participant's detail page.
// Search runs server-side via GET /clients, which matches preferred name,
// suburb, postcode and the NDIS-number blind index (legal names are encrypted
// at rest and so are not searchable here).

const api = useApi()
const router = useRouter()

const open = ref(false)
const q = ref('')
const results = ref([])
const active = ref(0)
const busy = ref(false)
const inputEl = ref(null)
let debounce = null
let seq = 0

function displayName (c) {
  return c.preferred_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || `Client #${c.id}`
}

function show () {
  open.value = true
  nextTick(() => inputEl.value?.focus())
}

function close () {
  open.value = false
  q.value = ''
  results.value = []
  active.value = 0
}

async function search () {
  const term = q.value.trim()
  if (!term) { results.value = []; active.value = 0; return }
  const mine = ++seq
  busy.value = true
  try {
    const res = await api.get('/clients', { q: term, active: 'true', per_page: 8 })
    if (mine !== seq) return // a newer search has superseded this one
    results.value = res.data
    active.value = 0
  } catch {
    if (mine === seq) results.value = []
  } finally {
    if (mine === seq) busy.value = false
  }
}

watch(q, () => {
  clearTimeout(debounce)
  debounce = setTimeout(search, 200)
})

function move (delta) {
  if (!results.value.length) return
  active.value = (active.value + delta + results.value.length) % results.value.length
}

function choose (client) {
  const target = client || results.value[active.value]
  if (!target) return
  router.push(`/clients/${target.id}`)
  close()
}

function onKeydown (e) {
  const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
  if (cmdK) {
    e.preventDefault()
    open.value ? close() : show()
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); choose() }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); clearTimeout(debounce) })

defineExpose({ show })
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh] bg-black/60" @click.self="close">
      <div class="card max-w-lg w-full !p-0 overflow-hidden">
        <div class="flex items-center gap-2 px-4 border-b border-white/10">
          <svg class="h-4 w-4 shrink-0 text-mid" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.3-4.3M11 18a7 7 0 110-14 7 7 0 010 14z" /></svg>
          <input
            ref="inputEl"
            v-model="q"
            type="text"
            placeholder="Search clients by name, suburb, postcode or NDIS number…"
            class="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-mid"
          />
          <span class="text-xs text-mid">Esc</span>
        </div>
        <ul v-if="results.length" class="max-h-80 overflow-y-auto py-1">
          <li
            v-for="(c, i) in results"
            :key="c.id"
            class="px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3"
            :class="i === active ? 'bg-primary/20' : 'hover:bg-white/5'"
            @mouseenter="active = i"
            @click="choose(c)"
          >
            <div class="min-w-0">
              <p class="text-sm font-medium truncate">{{ displayName(c) }}</p>
              <p class="text-xs text-mid truncate">{{ [c.suburb, c.state].filter(Boolean).join(', ') || 'No address' }}</p>
            </div>
            <span class="text-xs text-mid whitespace-nowrap">{{ c.ndis_number || '' }}</span>
          </li>
        </ul>
        <p v-else-if="q.trim() && !busy" class="px-4 py-6 text-sm text-mid text-center">No matching clients.</p>
        <p v-else-if="!q.trim()" class="px-4 py-6 text-xs text-mid text-center">Type to search. Legal names are encrypted — search by preferred name, suburb, postcode or NDIS number.</p>
      </div>
    </div>
  </teleport>
</template>
