<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import BillingCodePicker from './BillingCodePicker.vue'
import StatusBadge from './StatusBadge.vue'

const props = defineProps({
  shift: { type: Object, default: null }, // existing scheduled shift, or null for new
  clients: { type: Array, default: () => [] },
  defaultDate: { type: String, default: '' }
})
const emit = defineEmits(['close', 'changed', 'create-note'])

const api = useApi()
const toast = useToastStore()
const busy = ref(false)
const recurring = ref(false)

const WEEKDAYS = [
  { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }, { v: 0, l: 'Sun' }
]

const isExisting = computed(() => !!props.shift?.id)
const status = computed(() => props.shift?.status || 'scheduled')
const locked = computed(() => isExisting.value && (status.value === 'completed' || status.value === 'cancelled'))

const form = reactive({
  client_id: null, title: '', scheduled_date: props.defaultDate || new Date().toISOString().slice(0, 10),
  start_time: '', end_time: '', billing_code_id: null, location: '', plan_notes: ''
})
const recur = reactive({ frequency: 'weekly', interval: 1, weekdays: [], until_date: '' })

watch(() => props.shift, value => {
  if (value && Object.keys(value).length) {
    for (const k of Object.keys(form)) if (k in value) form[k] = value[k] ?? (typeof form[k] === 'number' ? null : '')
    form.client_id = value.client_id ?? null
  }
}, { immediate: true })

const statusForBadge = computed(() => ({
  scheduled: 'draft', in_progress: 'active', completed: 'finalised', cancelled: 'unbilled'
}[status.value] || 'draft'))

function toggleWeekday (v) {
  const i = recur.weekdays.indexOf(v)
  if (i === -1) recur.weekdays.push(v); else recur.weekdays.splice(i, 1)
}

/** Build the one-off payload from the form (empty strings → null). */
function payload () {
  return {
    client_id: Number(form.client_id),
    title: form.title || null,
    scheduled_date: form.scheduled_date,
    start_time: form.start_time || null,
    end_time: form.end_time || null,
    billing_code_id: form.billing_code_id ? Number(form.billing_code_id) : null,
    location: form.location || null,
    plan_notes: form.plan_notes || null
  }
}

async function save () {
  if (!form.client_id) { toast.push('Choose a participant', 'warning'); return }
  busy.value = true
  try {
    if (isExisting.value) {
      await api.put(`/schedule/${props.shift.id}`, payload())
      toast.push('Scheduled shift updated', 'success')
    } else if (recurring.value) {
      await api.post('/schedule/recurrences', {
        ...payload(),
        scheduled_date: undefined,
        start_date: form.scheduled_date,
        frequency: recur.frequency,
        interval: Number(recur.interval) || 1,
        weekdays: recur.weekdays.length ? recur.weekdays : null,
        until_date: recur.until_date || null
      })
      toast.push('Recurring appointment created', 'success')
    } else {
      await api.post('/schedule', payload())
      toast.push('Shift scheduled', 'success')
    }
    emit('changed'); emit('close')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function act (verb, label) {
  busy.value = true
  try {
    await api.post(`/schedule/${props.shift.id}/${verb}`, {})
    toast.push(label, 'success')
    if (verb === 'clock-out') { emit('changed'); emit('create-note', props.shift.id); return }
    emit('changed'); emit('close')
  } catch { /* toast via interceptor */ } finally {
    busy.value = false
  }
}

async function cancelShift () {
  if (!confirm('Cancel this scheduled shift?')) return
  busy.value = true
  try { await api.post(`/schedule/${props.shift.id}/cancel`, {}); toast.push('Shift cancelled', 'success'); emit('changed'); emit('close') } catch { /* */ } finally { busy.value = false }
}

async function remove () {
  if (!confirm('Delete this scheduled shift? It can be restored from Deleted Items.')) return
  busy.value = true
  try { await api.del(`/schedule/${props.shift.id}`); toast.push('Scheduled shift deleted', 'success'); emit('changed'); emit('close') } catch { /* */ } finally { busy.value = false }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" @click.self="emit('close')">
    <div class="card w-full max-w-2xl my-8 space-y-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">{{ isExisting ? 'Scheduled shift' : 'Schedule a shift' }}</h2>
        <div class="flex items-center gap-2">
          <StatusBadge v-if="isExisting" :status="statusForBadge" />
          <button class="text-mid hover:text-white" aria-label="Close" @click="emit('close')">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>

      <!-- Clock in / out / note actions for an existing shift -->
      <div v-if="isExisting && status !== 'cancelled'" class="flex flex-wrap items-center gap-2 rounded-xl bg-deep/60 border border-white/10 p-3">
        <template v-if="status === 'scheduled'">
          <button class="btn-accent" :disabled="busy" @click="act('clock-in', 'Clocked in')">▶ Clock in</button>
          <span class="text-xs text-mid">Start the shift when you arrive.</span>
        </template>
        <template v-else-if="status === 'in_progress'">
          <button class="btn-primary" :disabled="busy" @click="act('clock-out', 'Clocked out')">⏹ Clock out &amp; write note</button>
          <span class="text-xs text-mid">In progress since {{ new Date(shift.clock_in_at).toLocaleTimeString() }}.</span>
        </template>
        <template v-else-if="status === 'completed'">
          <router-link v-if="shift.shift_note_id" :to="`/shifts/${shift.shift_note_id}`" class="btn-ghost">Open shift note</router-link>
          <button v-else class="btn-accent" :disabled="busy" @click="emit('create-note', shift.id)">Write shift note</button>
          <span class="text-xs text-mid">Completed.</span>
        </template>
      </div>

      <div class="grid sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2">
          <label class="label">Participant *</label>
          <select v-model="form.client_id" class="input" :disabled="locked || isExisting" required>
            <option :value="null" disabled>— Select —</option>
            <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.preferred_name || `${c.first_name} ${c.last_name}` }}</option>
          </select>
        </div>
        <div class="sm:col-span-2"><label class="label">Title (optional)</label><input v-model="form.title" class="input" :disabled="locked" placeholder="e.g. Community access" /></div>
        <div><label class="label">{{ recurring ? 'First date *' : 'Date *' }}</label><input v-model="form.scheduled_date" type="date" class="input" :disabled="locked" required /></div>
        <div><label class="label">Location</label><input v-model="form.location" class="input" :disabled="locked" /></div>
        <div><label class="label">Start</label><input v-model="form.start_time" type="time" class="input" :disabled="locked" /></div>
        <div><label class="label">End</label><input v-model="form.end_time" type="time" class="input" :disabled="locked" /></div>
        <div class="sm:col-span-2">
          <label class="label">Support item</label>
          <BillingCodePicker v-model="form.billing_code_id" :client-id="form.client_id" :disabled="locked" />
        </div>
        <div class="sm:col-span-2">
          <label class="label">Plan notes (encrypted)</label>
          <textarea v-model="form.plan_notes" class="input" rows="2" :disabled="locked" placeholder="What's planned for this shift" />
        </div>
      </div>

      <!-- Recurrence (new shifts only) -->
      <div v-if="!isExisting" class="rounded-xl border border-white/10 p-3 space-y-3">
        <label class="flex items-center gap-2 text-sm"><input v-model="recurring" type="checkbox" class="accent-accent" /> Repeat this appointment</label>
        <div v-if="recurring" class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="label">Frequency</label>
            <select v-model="recur.frequency" class="input">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div><label class="label">Every (interval)</label><input v-model="recur.interval" type="number" min="1" max="52" class="input" /></div>
          <div v-if="recur.frequency === 'weekly' || recur.frequency === 'fortnightly'" class="sm:col-span-2">
            <label class="label">On days</label>
            <div class="flex flex-wrap gap-1">
              <button v-for="d in WEEKDAYS" :key="d.v" type="button" class="btn-ghost !px-3 !py-1 text-xs"
                :class="recur.weekdays.includes(d.v) ? '!bg-primary/30 !text-white' : ''" @click="toggleWeekday(d.v)">{{ d.l }}</button>
            </div>
          </div>
          <div class="sm:col-span-2"><label class="label">Until (optional)</label><input v-model="recur.until_date" type="date" class="input" /></div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button v-if="!locked" class="btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : (isExisting ? 'Save changes' : 'Schedule') }}</button>
        <template v-if="isExisting">
          <button v-if="status !== 'completed' && status !== 'cancelled'" class="btn-ghost ml-auto" :disabled="busy" @click="cancelShift">Cancel shift</button>
          <button class="btn-ghost text-danger" :disabled="busy" @click="remove">Delete</button>
        </template>
      </div>
    </div>
  </div>
</template>
