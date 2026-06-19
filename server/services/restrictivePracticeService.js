import { sqlite } from '../db/connection.js'
import { encrypt, decryptFields } from './cryptoService.js'
import { getClient } from './clientService.js'
import { ApiError } from '../middleware/errorHandler.js'

// Narrative fields encrypted at rest (like shift bodies).
const ENCRYPTED = ['description', 'antecedent', 'alternatives_tried', 'outcome']
const COLUMNS = ['practice_type', 'used_at_date', 'used_at_time', 'duration_minutes',
  'authorised', 'authorisation_ref', 'reported_to_commission', 'shift_note_id',
  'description', 'antecedent', 'alternatives_tried', 'outcome']

// NOT NULL columns with a DB default — coerce a missing value so the service is
// robust to direct callers, not only Zod-validated route bodies.
const DEFAULTS = { practice_type: 'environmental', authorised: 0, reported_to_commission: 0 }

const now = () => new Date().toISOString()

/** Decrypt the narrative fields of a record row. */
function toRecord (row) {
  return row ? decryptFields(row, ENCRYPTED) : null
}

/**
 * List a participant's restrictive-practice records, newest use first.
 * @param {number} clientId
 * @param {{practice_type?:string}} [filters]
 * @returns {object[]}
 */
export function listRestrictivePractices (clientId, filters = {}) {
  const where = ['client_id = ?', 'deleted_at IS NULL']
  const params = [clientId]
  if (filters.practice_type) { where.push('practice_type = ?'); params.push(filters.practice_type) }
  return sqlite.prepare(`SELECT * FROM restrictive_practice_records
    WHERE ${where.join(' AND ')} ORDER BY used_at_date DESC, id DESC`).all(...params).map(toRecord)
}

/**
 * Fetch one restrictive-practice record (decrypted) or throw 404.
 * @param {number} clientId
 * @param {number} id
 * @returns {object}
 */
export function getRestrictivePractice (clientId, id) {
  const row = sqlite.prepare('SELECT * FROM restrictive_practice_records WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(id, clientId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Restrictive-practice record not found')
  return toRecord(row)
}

/**
 * Create a restrictive-practice record for a participant.
 * @param {number} clientId
 * @param {object} data validated payload
 * @param {number} workerId
 * @returns {object}
 */
export function createRestrictivePractice (clientId, data, workerId) {
  getClient(clientId)
  const ts = now()
  const cols = ['client_id', 'worker_id', ...COLUMNS, 'created_at', 'updated_at']
  const values = COLUMNS.map(c => {
    const v = data[c] ?? DEFAULTS[c] ?? null
    return ENCRYPTED.includes(c) ? encrypt(v) : v
  })
  const result = sqlite.prepare(`INSERT INTO restrictive_practice_records (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(clientId, workerId, ...values, ts, ts)
  return getRestrictivePractice(clientId, result.lastInsertRowid)
}

/**
 * Update a restrictive-practice record (partial).
 * @param {number} clientId
 * @param {number} id
 * @param {object} data
 * @returns {object}
 */
export function updateRestrictivePractice (clientId, id, data) {
  getRestrictivePractice(clientId, id)
  const sets = []
  const params = []
  for (const col of COLUMNS) {
    if (!(col in data)) continue
    sets.push(`${col} = ?`)
    params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE restrictive_practice_records SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  return getRestrictivePractice(clientId, id)
}

/**
 * Soft-delete a restrictive-practice record (regulated — never hard-deleted).
 * @param {number} clientId
 * @param {number} id
 */
export function deleteRestrictivePractice (clientId, id) {
  getRestrictivePractice(clientId, id)
  sqlite.prepare('UPDATE restrictive_practice_records SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Restore a soft-deleted record (Deleted-items recycle bin; keyed by id alone).
 * @param {number} id
 * @returns {object}
 */
export function restoreRestrictivePractice (id) {
  const row = sqlite.prepare('SELECT client_id FROM restrictive_practice_records WHERE id = ? AND deleted_at IS NOT NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted restrictive-practice record not found')
  sqlite.prepare('UPDATE restrictive_practice_records SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  return getRestrictivePractice(row.client_id, id)
}
