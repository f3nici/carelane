import { sqlite } from '../db/connection.js'
import { encrypt, decrypt } from './cryptoService.js'
import { ApiError } from '../middleware/errorHandler.js'
import { getClient } from './clientService.js'

const now = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)

/** Goal lifecycle states. */
export const GOAL_STATUSES = new Set(['active', 'achieved', 'on_hold', 'discontinued'])

const GOAL_COLUMNS = ['title', 'description', 'category', 'status', 'target_date', 'sort_order']

/**
 * Decrypt a progress note row (the body is encrypted at rest like shift bodies).
 * @param {object} row
 */
function toProgressNote (row) {
  if (!row) return null
  return { ...row, body: decrypt(row.body) }
}

/**
 * List a client's goals (active first, then by sort order) with a progress
 * summary: the count of notes, the most recent note date and its rating.
 * @param {number} clientId
 * @param {{status?:string}} [filters]
 * @returns {object[]}
 */
export function listGoals (clientId, filters = {}) {
  const where = ['g.client_id = ?', 'g.deleted_at IS NULL']
  const params = [clientId]
  if (filters.status && GOAL_STATUSES.has(filters.status)) { where.push('g.status = ?'); params.push(filters.status) }
  return sqlite.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM goal_progress_notes p WHERE p.goal_id = g.id AND p.deleted_at IS NULL) AS progress_count,
      (SELECT MAX(p.note_date) FROM goal_progress_notes p WHERE p.goal_id = g.id AND p.deleted_at IS NULL) AS last_progress_date
    FROM client_goals g
    WHERE ${where.join(' AND ')}
    ORDER BY (g.status != 'active'), g.sort_order, g.created_at DESC`).all(...params)
}

/**
 * Fetch one goal (with its decrypted progress notes, newest first) or throw 404.
 * @param {number} clientId
 * @param {number} id
 * @returns {object}
 */
export function getGoal (clientId, id) {
  const row = sqlite.prepare('SELECT * FROM client_goals WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(id, clientId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Goal not found')
  const progress = sqlite.prepare(`SELECT * FROM goal_progress_notes
    WHERE goal_id = ? AND deleted_at IS NULL ORDER BY note_date DESC, id DESC`).all(id).map(toProgressNote)
  return { ...row, progress }
}

/**
 * Create a goal for a client.
 * @param {number} clientId
 * @param {object} data validated goal payload
 * @returns {object}
 */
export function createGoal (clientId, data) {
  getClient(clientId)
  const ts = now()
  const values = GOAL_COLUMNS.map(c => c === 'sort_order' ? (data.sort_order ?? 0) : (data[c] ?? null))
  const cols = ['client_id', ...GOAL_COLUMNS, 'created_at', 'updated_at']
  const result = sqlite.prepare(`INSERT INTO client_goals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(clientId, ...values, ts, ts)
  return getGoal(clientId, result.lastInsertRowid)
}

/**
 * Update a goal (partial — only submitted fields are touched).
 * @param {number} clientId
 * @param {number} id
 * @param {object} data
 * @returns {object}
 */
export function updateGoal (clientId, id, data) {
  getGoal(clientId, id)
  const sets = []
  const params = []
  for (const col of GOAL_COLUMNS) {
    if (!(col in data)) continue
    sets.push(`${col} = ?`)
    params.push(data[col] ?? null)
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE client_goals SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  return getGoal(clientId, id)
}

/**
 * Soft-delete a goal (and hide its progress notes with it). Regulated record —
 * never hard-deleted.
 * @param {number} clientId
 * @param {number} id
 */
export function deleteGoal (clientId, id) {
  getGoal(clientId, id)
  sqlite.prepare('UPDATE client_goals SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Restore a soft-deleted goal (for the Deleted-items recycle bin). Looked up by
 * id alone since the restore registry is keyed by type+id.
 * @param {number} id
 * @returns {object}
 */
export function restoreGoal (id) {
  const row = sqlite.prepare('SELECT client_id FROM client_goals WHERE id = ? AND deleted_at IS NOT NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted goal not found')
  sqlite.prepare('UPDATE client_goals SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  return getGoal(row.client_id, id)
}

/**
 * Add a dated progress note to a goal. The body is encrypted at rest like shift
 * note bodies.
 * @param {number} clientId
 * @param {number} goalId
 * @param {{note_date?:string, progress_rating?:number, body?:string}} data validated payload
 * @returns {object} the updated goal (with progress)
 */
export function addProgressNote (clientId, goalId, data) {
  getGoal(clientId, goalId)
  sqlite.prepare(`INSERT INTO goal_progress_notes (goal_id, client_id, note_date, progress_rating, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(goalId, clientId, data.note_date || today(), data.progress_rating ?? null, encrypt(data.body ?? null), now())
  // Touch the goal so list ordering / updated_at reflects the new activity.
  sqlite.prepare('UPDATE client_goals SET updated_at = ? WHERE id = ?').run(now(), goalId)
  return getGoal(clientId, goalId)
}

/**
 * Soft-delete a single progress note.
 * @param {number} clientId
 * @param {number} goalId
 * @param {number} noteId
 * @returns {object} the updated goal (with progress)
 */
export function deleteProgressNote (clientId, goalId, noteId) {
  getGoal(clientId, goalId)
  const row = sqlite.prepare('SELECT id FROM goal_progress_notes WHERE id = ? AND goal_id = ? AND deleted_at IS NULL').get(noteId, goalId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Progress note not found')
  sqlite.prepare('UPDATE goal_progress_notes SET deleted_at = ? WHERE id = ?').run(now(), noteId)
  return getGoal(clientId, goalId)
}

/**
 * Build a compact, structured goals summary for AI report drafting. Lists each
 * active/achieved goal with its status and the most recent progress note,
 * giving the drafter structured outcome material instead of only shift-note
 * bodies. Returns null when the participant has no structured goals (callers
 * fall back to the free-text support_goals field).
 * @param {number} clientId
 * @param {number} [perGoalNotes] how many recent progress notes to include per goal
 * @returns {string|null}
 */
export function buildGoalsSummary (clientId, perGoalNotes = 3) {
  const goals = sqlite.prepare(`SELECT * FROM client_goals
    WHERE client_id = ? AND deleted_at IS NULL AND status IN ('active', 'achieved', 'on_hold')
    ORDER BY (status != 'active'), sort_order, created_at`).all(clientId)
  if (!goals.length) return null
  const recent = sqlite.prepare(`SELECT note_date, progress_rating, body FROM goal_progress_notes
    WHERE goal_id = ? AND deleted_at IS NULL ORDER BY note_date DESC, id DESC LIMIT ?`)
  const lines = []
  for (const g of goals) {
    const label = g.status === 'active' ? '' : ` [${g.status.replace('_', ' ')}]`
    lines.push(`- ${g.title}${label}${g.target_date ? ` (target ${g.target_date})` : ''}`)
    if (g.description) lines.push(`  Goal: ${g.description}`)
    for (const p of recent.all(g.id, perGoalNotes)) {
      const rating = p.progress_rating ? ` (progress ${p.progress_rating}/5)` : ''
      const body = decrypt(p.body)
      if (body) lines.push(`  ${p.note_date}${rating}: ${body}`)
    }
  }
  return lines.join('\n')
}
