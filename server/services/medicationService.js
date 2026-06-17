import { sqlite } from '../db/connection.js'
import { encrypt, decryptFields } from './cryptoService.js'
import { getClient } from './clientService.js'
import { ApiError } from '../middleware/errorHandler.js'

// The PRN/refusal reason and free-text notes are encrypted at rest; the
// medication name/dose stay plain so the administration log is listable.
const ENCRYPTED = ['reason', 'notes']
const COLUMNS = ['medication_name', 'dose', 'route', 'administered_date', 'administered_time',
  'prn', 'status', 'shift_note_id', 'reason', 'notes', 'witnessed_by']

// NOT NULL columns with a DB default — coerce a missing value so the service is
// robust to direct callers, not only Zod-validated route bodies.
const DEFAULTS = { prn: 0, status: 'administered' }

const now = () => new Date().toISOString()

/** Decrypt the encrypted fields of a record row. */
function toRecord (row) {
  return row ? decryptFields(row, ENCRYPTED) : null
}

/**
 * List a participant's medication administration records, newest first.
 * @param {number} clientId
 * @param {{status?:string}} [filters]
 * @returns {object[]}
 */
export function listMedicationRecords (clientId, filters = {}) {
  const where = ['client_id = ?', 'deleted_at IS NULL']
  const params = [clientId]
  if (filters.status) { where.push('status = ?'); params.push(filters.status) }
  return sqlite.prepare(`SELECT * FROM medication_records
    WHERE ${where.join(' AND ')} ORDER BY administered_date DESC, administered_time DESC, id DESC`).all(...params).map(toRecord)
}

/**
 * Fetch one medication record (decrypted) or throw 404.
 * @param {number} clientId
 * @param {number} id
 * @returns {object}
 */
export function getMedicationRecord (clientId, id) {
  const row = sqlite.prepare('SELECT * FROM medication_records WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(id, clientId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Medication record not found')
  return toRecord(row)
}

/**
 * Create a medication administration record for a participant.
 * @param {number} clientId
 * @param {object} data validated payload
 * @param {number} workerId
 * @returns {object}
 */
export function createMedicationRecord (clientId, data, workerId) {
  getClient(clientId)
  const ts = now()
  const cols = ['client_id', 'worker_id', ...COLUMNS, 'created_at', 'updated_at']
  const values = COLUMNS.map(c => {
    const v = data[c] ?? DEFAULTS[c] ?? null
    return ENCRYPTED.includes(c) ? encrypt(v) : v
  })
  const result = sqlite.prepare(`INSERT INTO medication_records (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(clientId, workerId, ...values, ts, ts)
  return getMedicationRecord(clientId, result.lastInsertRowid)
}

/**
 * Update a medication record (partial).
 * @param {number} clientId
 * @param {number} id
 * @param {object} data
 * @returns {object}
 */
export function updateMedicationRecord (clientId, id, data) {
  getMedicationRecord(clientId, id)
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
    sqlite.prepare(`UPDATE medication_records SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  return getMedicationRecord(clientId, id)
}

/**
 * Soft-delete a medication record (regulated — never hard-deleted).
 * @param {number} clientId
 * @param {number} id
 */
export function deleteMedicationRecord (clientId, id) {
  getMedicationRecord(clientId, id)
  sqlite.prepare('UPDATE medication_records SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Restore a soft-deleted record (Deleted-items recycle bin; keyed by id alone).
 * @param {number} id
 * @returns {object}
 */
export function restoreMedicationRecord (id) {
  const row = sqlite.prepare('SELECT client_id FROM medication_records WHERE id = ? AND deleted_at IS NOT NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted medication record not found')
  sqlite.prepare('UPDATE medication_records SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  return getMedicationRecord(row.client_id, id)
}
