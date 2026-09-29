<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import BillingCodePicker from './BillingCodePicker.vue'

// Whole-series editor for a recurring appointment. A materialised occurrence on
// the roster can only ever be edited one day at a time; this is the other half —
// change the rule (time, location, support item, assigned worker, how often it
// repeats) and every upcoming occurrence is regenerated from it, or stop/delete
// the series outright. Worked, in-progress and individually cancelled shifts are
// history: the server never rewrites them, so the roster's past stays accurate.

const props = defineProps({
  // The series to edit. Only `id` is required — the current rule is re-fetched
  // so the occurrence counts shown in the warnings are never stale.
  seriesId: { type: Number, required: true },
  clients: { type: Array, default: () => [] },
  workers: { type: Array, default: () => [] },
  // Prefills "stop repeating from" — the date of the occurrence this was opened
  // from, so "stop from this one onward" is a single click.
  defaultEndFrom: { type: String, default: '' }
})
const emit = defineEmits(['close', 'changed'])

const api = useApi()
const toast = useToastStore()

const WEEKDAYS = [
  { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }, { v: 0, l: 'Sun' }
]
const FREQUENCY_LABEL = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }

const busy = ref(false)
const loading = ref(true)
const series = ref(null)
const endFrom = ref(props.defaultEndFrom || new Date().toISOString().slice(0, 10))

const form = reactive({
  worker_id: null, title: '', frequency: 'weekly', interval: 1, weekdays: [],
  start_date: '', until_date: '', start_time: '', end_time: '',
  billing_code_id: null, location: '', plan_notes: '', active: true
})

// The picker offers active support workers, plus whoever the series is
// currently rostered to when that is someone the list doesn't carry (the admin
// themselves, or a worker who has since been deactivated) — otherwise the
// select would render blank and a save would silently re-roster the series.
const workerOptions = computed(() => {
  const opts = props.workers.map(w => ({ id: w.id, label: w.display_name }))
  const current = form.worker_id
  if (current && !opts.some(o => o.id === current)) {
    opts.unshift({ id: current, label: series.value?.worker_display_name || `User #${current}` })
  }
  return opts
})

const upcoming = computed(() => series.value?.upcoming_count ?? 0)
const kept = computed(() => series.value?.kept_count ?? 0)
const isIndefinite = computed(() => !form.until_date)

/** "3 upcoming shifts" / "1 upcoming shift" — used throughout the warnings. */
const shifts = n => `${n} upcoming shift${n === 1 ? '' : 's'}`

const repeatSummary = computed(() => {
  const every = Number(form.interval) > 1 ? `every ${form.interval} ${FREQUENCY_LABEL[form.frequency]}s` : `every ${FREQUENCY_LABEL[form.frequency]}`
  const days = form.weekdays.length
    ? ` on ${WEEKDAYS.filter(d => form.weekdays.includes(d.v)).map(d => d.l).join(', ')}`
    : ''
  return `Repeats ${every}${days}, ${form.until_date ? `until ${form.until_date}` : 'indefinitely'}.`
})

onMounted(load)

async function load () {
  loading.value = true
  try {
    const res = await api.get(`/schedule/recurrences/${props.seriesId}`)
    series.value = res.data
    for (const k of Object.keys(form)) if (k in res.data) form[k] = res.data[k] ?? (typeof form[k] === 'number' ? null : '')
    form.weekdays = res.data.weekdays ? [...res.data.weekdays] : []
    form.interval = res.data.interval || 1
    form.active = !!res.data.active
    form.until_date = res.data.until_date || ''
  } catch { emit('close') } finally { loading.value = false }
}

function toggleWeekday (v) {
  const i = form.weekdays.indexOf(v)
  if (i === -1) form.weekdays.push(v); else form.weekdays.splice(i, 1)
}

/** Apply the edited rule to the series and every upcoming occurrence. */
async function saveAll () {
  // A bulk edit multiplies a slip across every upcoming shift, so catch the
  // obvious one before it lands on all of them.
  if (form.start_time && form.end_time && form.end_time <= form.start_time) {
    toast.push('The end time must be after the start time', 'warning')
    return
  }
  if (!confirm(`Apply these changes to the whole series? ${shifts(upcoming.value)} will be rewritten.` +
    (kept.value ? ` ${kept.value} already worked or cancelled shift${kept.value === 1 ? '' : 's'} will not change.` : ''))) return
  busy.value = true
  try {
    const res = await api.put(`/schedule/recurrences/${props.seriesId}`, {
      worker_id: form.worker_id ? Number(form.worker_id) : null,
      title: form.title || null,
      frequency: form.frequency,
      interval: Number(form.interval) || 1,
      weekdays: form.weekdays.length ? form.weekdays : null,
      start_date: form.start_date,
      until_date: form.until_date || null,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      billing_code_id: form.billing_code_id ? Number(form.billing_code_id) : null,
      location: form.location || null,
      plan_notes: form.plan_notes || null,
      active: form.active ? 1 : 0
    })
    toast.push(`Series updated — ${shifts(res.data.occurrences_created)} rescheduled`, 'success')
    emit('changed'); emit('close')
  } catch { /* toast via interceptor */ } finally { busy.value = false }
}

/** Stop an open-ended series from a date onward, keeping everything before it. */
async function stopFrom () {
  if (!endFrom.value) { toast.push('Choose the date to stop from', 'warning'); return }
  if (!confirm(`Stop this appointment repeating from ${endFrom.value}? Shifts on and after that date are removed; earlier ones stay on the roster.`)) return
  busy.value = true
  try {
    const res = await api.post(`/schedule/recurrences/${props.seriesId}/end`, { from: endFrom.value })
    toast.push(`Series ended — ${res.data.occurrences_removed} upcoming shift${res.data.occurrences_removed === 1 ? '' : 's'} removed`, 'success')
    emit('changed'); emit('close')
  } catch { /* toast via interceptor */ } finally { busy.value = false }
}

/** Delete the series and every upcoming occurrence it created. */
async function removeAll () {
  if (!confirm(`Delete this repeating appointment and all ${shifts(upcoming.value)}?` +
    (kept.value ? ` ${kept.value} already worked or cancelled shift${kept.value === 1 ? '' : 's'} stay on the roster as history.` : ''))) return
  busy.value = true
  try {
    const res = await api.del(`/schedule/recurrences/${props.seriesId}`)
    toast.push(`Repeating appointment deleted — ${res.data.occurrences_removed} upcoming shift${res.data.occurrences_removed === 1 ? '' : 's'} removed`, 'success')
    emit('changed'); emit('close')
  } catch { /* toast via interceptor */ } finally { busy.value = false }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" @click.self="emit('close')">
    <div class="card w-full max-w-2xl my-8 space-y-5">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-lg font-semibold">Repeating appointment</h2>
          <p v-if="series" class="text-xs text-mid truncate">{{ series.client_display_name }}<template v-if="series.title"> · {{ series.title }}</template></p>
        </div>
        <button class="text-mid hover:text-white" aria-label="Close" @click="emit('close')">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <p v-if="loading" class="text-sm text-mid">Loading series…</p>

      <template v-else-if="series">
        <div class="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm space-y-1">
          <p>Changes here apply to <strong>every upcoming shift</strong> in this series — {{ shifts(upcoming) }}.</p>
          <p v-if="kept" class="text-xs text-mid">{{ kept }} shift{{ kept === 1 ? '' : 's' }} already worked, in progress or cancelled will not be touched.</p>
          <p class="text-xs text-mid">{{ repeatSummary }}</p>
        </div>

        <div class="grid sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="label">Participant</label>
            <input class="input" :value="series.client_display_name" disabled />
            <p class="text-xs text-mid mt-1">Create a new series to roster a different participant.</p>
          </div>
          <div class="sm:col-span-2">
            <label class="label">Support worker</label>
            <select v-model="form.worker_id" class="input">
              <option :value="null">— Me (unassigned)</option>
              <option v-for="w in workerOptions" :key="w.id" :value="w.id">{{ w.label }}</option>
            </select>
            <p class="text-xs text-mid mt-1">Re-rosters every upcoming shift in the series.</p>
          </div>
          <div class="sm:col-span-2"><label class="label">Title (optional)</label><input v-model="form.title" class="input" placeholder="e.g. Community access" /></div>
          <div>
            <label class="label">Frequency</label>
            <select v-model="form.frequency" class="input">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div><label class="label">Every (interval)</label><input v-model="form.interval" type="number" min="1" max="52" class="input" /></div>
          <div v-if="form.frequency === 'weekly' || form.frequency === 'fortnightly'" class="sm:col-span-2">
            <label class="label">On days</label>
            <div class="flex flex-wrap gap-1">
              <button v-for="d in WEEKDAYS" :key="d.v" type="button" class="btn-ghost !px-3 !py-1 text-xs"
                :class="form.weekdays.includes(d.v) ? '!bg-primary/30 !text-white' : ''" @click="toggleWeekday(d.v)">{{ d.l }}</button>
            </div>
          </div>
          <div><label class="label">First date</label><input v-model="form.start_date" type="date" class="input" /></div>
          <div>
            <label class="label">Until (optional)</label>
            <input v-model="form.until_date" type="date" class="input" />
            <p v-if="isIndefinite" class="text-xs text-mid mt-1">Runs indefinitely.</p>
          </div>
          <div><label class="label">Start</label><input v-model="form.start_time" type="time" class="input" /></div>
          <div><label class="label">End</label><input v-model="form.end_time" type="time" class="input" /></div>
          <div><label class="label">Location</label><input v-model="form.location" class="input" /></div>
          <div>
            <label class="label">Status</label>
            <label class="flex items-center gap-2 text-sm pt-2"><input v-model="form.active" type="checkbox" class="accent-accent" /> Keep scheduling new shifts</label>
          </div>
          <div class="sm:col-span-2">
            <label class="label">Support item</label>
            <BillingCodePicker v-model="form.billing_code_id" :client-id="series.client_id" />
          </div>
          <div class="sm:col-span-2">
            <label class="label">Plan notes (encrypted)</label>
            <textarea v-model="form.plan_notes" class="input" rows="2" placeholder="What's planned for these shifts" />
          </div>
        </div>

        <!-- Ending the series: the non-destructive way to stop an indefinite run -->
        <div class="rounded-xl border border-white/10 p-3 space-y-2">
          <p class="text-sm font-medium">Stop repeating</p>
          <p class="text-xs text-mid">Removes the upcoming shifts from a date onward and leaves everything before it on the roster.</p>
          <div class="flex flex-wrap items-end gap-2">
            <div class="grow max-w-[12rem]"><label class="label">From</label><input v-model="endFrom" type="date" class="input" /></div>
            <button class="btn-ghost" :disabled="busy" @click="stopFrom">Stop from this date</button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-1">
          <button class="btn-primary" :disabled="busy" @click="saveAll">{{ busy ? 'Saving…' : 'Save to all upcoming shifts' }}</button>
          <button class="btn-ghost text-danger ml-auto" :disabled="busy" @click="removeAll">Delete series</button>
        </div>
      </template>
    </div>
  </div>
</template>
