<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from '../stores/toast.js'
import StatusBadge from './StatusBadge.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps({
  clientId: { type: [String, Number], required: true },
  // Support workers view goals + progress read-only (no add/edit/archive controls).
  readonly: { type: Boolean, default: false }
})
const emit = defineEmits(['count'])

const api = useApi()
const toast = useToastStore()

const goals = ref([])
const expanded = ref({}) // goalId -> full goal (with progress)
const showNew = ref(false)
const editingId = ref(null)
const pendingDelete = ref(null) // goal awaiting delete confirmation
const STATUSES = ['active', 'achieved', 'on_hold', 'discontinued']

const blankGoal = () => ({ title: '', description: '', category: '', status: 'active', target_date: '' })
const form = reactive(blankGoal())
const progressForm = reactive({}) // goalId -> { note_date, progress_rating, body }

async function load () {
  const res = await api.get(`/clients/${props.clientId}/goals`)
  goals.value = res.data
  emit('count', goals.value.length)
}
onMounted(load)

function startNew () {
  Object.assign(form, blankGoal())
  editingId.value = null
  showNew.value = true
}

function startEdit (goal) {
  Object.assign(form, {
    title: goal.title, description: goal.description || '', category: goal.category || '',
    status: goal.status, target_date: goal.target_date || ''
  })
  editingId.value = goal.id
  showNew.value = true
}

function payload () {
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    category: form.category.trim() || null,
    status: form.status,
    target_date: form.target_date || null
  }
}

async function saveGoal () {
  if (!form.title.trim()) return
  try {
    if (editingId.value) await api.put(`/clients/${props.clientId}/goals/${editingId.value}`, payload())
    else await api.post(`/clients/${props.clientId}/goals`, payload())
    toast.push('Goal saved', 'success')
    showNew.value = false
    editingId.value = null
    await load()
  } catch { /* toast via interceptor */ }
}

async function setStatus (goal, status) {
  await api.put(`/clients/${props.clientId}/goals/${goal.id}`, { status })
  toast.push('Goal updated', 'success')
  await load()
  if (expanded.value[goal.id]) await openGoal(goal)
}

function confirmDelete (goal) {
  pendingDelete.value = goal
}

async function doDelete () {
  const goal = pendingDelete.value
  pendingDelete.value = null
  if (!goal) return
  await api.del(`/clients/${props.clientId}/goals/${goal.id}`)
  delete expanded.value[goal.id]
  toast.push('Goal archived', 'success')
  await load()
}

async function openGoal (goal) {
  if (expanded.value[goal.id]) {
    delete expanded.value[goal.id]
    return
  }
  const res = await api.get(`/clients/${props.clientId}/goals/${goal.id}`)
  expanded.value[goal.id] = res.data
  if (!progressForm[goal.id]) progressForm[goal.id] = { note_date: new Date().toISOString().slice(0, 10), progress_rating: '', body: '' }
}

async function addProgress (goalId) {
  const pf = progressForm[goalId]
  if (!pf?.body?.trim()) { toast.push('Add a progress note first', 'error'); return }
  const body = {
    note_date: pf.note_date || null,
    progress_rating: pf.progress_rating === '' || pf.progress_rating == null ? null : Number(pf.progress_rating),
    body: pf.body.trim()
  }
  const res = await api.post(`/clients/${props.clientId}/goals/${goalId}/progress`, body)
  expanded.value[goalId] = res.data
  progressForm[goalId] = { note_date: new Date().toISOString().slice(0, 10), progress_rating: '', body: '' }
  toast.push('Progress logged', 'success')
  await load()
}

async function removeProgress (goalId, noteId) {
  const res = await api.del(`/clients/${props.clientId}/goals/${goalId}/progress/${noteId}`)
  expanded.value[goalId] = res.data
  await load()
}
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="font-semibold">Goals</h3>
        <p class="text-xs text-mid">Track discrete participant outcomes with dated progress notes. These feed AI-drafted progress reports.</p>
      </div>
      <button v-if="!readonly" class="btn-primary" @click="startNew">+ New goal</button>
    </div>

    <form v-if="showNew" class="rounded-lg border border-white/10 p-4 mb-4 space-y-3" @submit.prevent="saveGoal">
      <p class="text-sm font-medium">{{ editingId ? 'Edit goal' : 'New goal' }}</p>
      <div><label class="label">Goal *</label><input v-model="form.title" class="input" placeholder="e.g. Travel independently by bus" required /></div>
      <div><label class="label">Description</label><textarea v-model="form.description" class="input" rows="2" placeholder="What does success look like?" /></div>
      <div class="grid sm:grid-cols-3 gap-3">
        <div><label class="label">Category</label><input v-model="form.category" class="input" placeholder="e.g. Independence" /></div>
        <div>
          <label class="label">Status</label>
          <select v-model="form.status" class="input">
            <option v-for="s in STATUSES" :key="s" :value="s">{{ s.replace('_', ' ') }}</option>
          </select>
        </div>
        <div><label class="label">Target date</label><input v-model="form.target_date" type="date" class="input" /></div>
      </div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">Save</button>
        <button class="btn-ghost" type="button" @click="showNew = false">Cancel</button>
      </div>
    </form>

    <p v-if="!goals.length" class="text-sm text-mid">No goals yet. Add the participant's NDIS goals to demonstrate outcomes over time.</p>

    <ul class="space-y-3">
      <li v-for="g in goals" :key="g.id" class="rounded-lg border border-white/10">
        <div class="p-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-medium">{{ g.title }}</span>
              <StatusBadge :status="g.status" />
              <span v-if="g.category" class="pill bg-white/10 text-mid">{{ g.category }}</span>
            </div>
            <p v-if="g.description" class="text-sm text-mid mt-1 whitespace-pre-wrap">{{ g.description }}</p>
            <p class="text-xs text-mid mt-1">
              <span v-if="g.target_date">Target {{ g.target_date }} · </span>
              {{ g.progress_count }} progress note{{ g.progress_count === 1 ? '' : 's' }}<span v-if="g.last_progress_date"> · last {{ g.last_progress_date }}</span>
            </p>
          </div>
          <div class="flex gap-2 shrink-0 text-xs">
            <button class="text-accent hover:underline" @click="openGoal(g)">{{ expanded[g.id] ? 'hide' : 'progress' }}</button>
            <template v-if="!readonly">
              <button class="text-accent hover:underline" @click="startEdit(g)">edit</button>
              <button v-if="g.status !== 'achieved'" class="text-success hover:underline" @click="setStatus(g, 'achieved')">achieved</button>
              <button class="text-danger hover:underline" @click="confirmDelete(g)">archive</button>
            </template>
          </div>
        </div>

        <div v-if="expanded[g.id]" class="border-t border-white/10 p-3 space-y-3">
          <ul v-if="expanded[g.id].progress?.length" class="space-y-2">
            <li v-for="p in expanded[g.id].progress" :key="p.id" class="text-sm flex items-start justify-between gap-3">
              <div class="min-w-0">
                <span class="text-mid">{{ p.note_date }}</span>
                <span v-if="p.progress_rating" class="pill bg-accent/15 text-accent ml-2">{{ p.progress_rating }}/5</span>
                <p class="whitespace-pre-wrap">{{ p.body }}</p>
              </div>
              <button v-if="!readonly" class="text-danger text-xs hover:underline shrink-0" @click="removeProgress(g.id, p.id)">remove</button>
            </li>
          </ul>
          <p v-else class="text-sm text-mid">No progress notes yet.</p>

          <div v-if="progressForm[g.id] && !readonly" class="rounded-lg bg-white/5 p-3 space-y-2">
            <div class="grid sm:grid-cols-3 gap-2">
              <div><label class="label">Date</label><input v-model="progressForm[g.id].note_date" type="date" class="input" /></div>
              <div>
                <label class="label">Progress (1–5)</label>
                <select v-model="progressForm[g.id].progress_rating" class="input">
                  <option value="">—</option>
                  <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
                </select>
              </div>
            </div>
            <div><label class="label">Note</label><textarea v-model="progressForm[g.id].body" class="input" rows="2" placeholder="What progress was observed this period?" /></div>
            <button class="btn-primary" @click="addProgress(g.id)">Log progress</button>
          </div>
        </div>
      </li>
    </ul>

    <ConfirmDialog
      :open="!!pendingDelete"
      title="Archive this goal?"
      message="The goal and its progress notes are soft-deleted and retained for record-keeping. Restore it later from Deleted items."
      confirm-label="Archive"
      danger
      @confirm="doDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
