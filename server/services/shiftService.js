import { sqlite } from '../db/connection.js'
import { encrypt, decryptFields } from './cryptoService.js'
import { ApiError } from '../middleware/errorHandler.js'

const ENCRYPTED = ['body', 'incident_details']
const COLUMNS = ['client_id', 'shift_date', 'start_time', 'end_time', 'duration_hours',
  'billing_code_id', 'location', 'support_provided', 'body', 'participant_response',
  'incident_flag', 'incident_details', 'follow_up_required', 'billed', 'finalised']

const now = () => new Date().toISOString()

function toShift (row) {
  return row ? decryptFields(row, ENCRYPTED) : null
}

/**
 * Compute duration in hours from HH:MM start/end times (overnight-safe).
 */
function computeDuration (start, end) {
  if (!start || !end) return null
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 100) / 100
}

/**
 * List shift notes with optional client / incident / billed filters.
 * @param {{page:number, perPage:number, offset:number}} pg
 * @param {{client_id?:string, incident?:string, billed?:string}} filters
 */
export function listShifts (pg, filters = {}) {
  const where = ['s.deleted_at IS NULL']
  const params = []
  if (filters.client_id) { where.push('s.client_id = ?'); params.push(Number(filters.client_id)) }
  if (filters.incident === 'true') where.push('s.incident_flag = 1')
  if (filters.billed === 'false') where.push('s.billed = 0')
  const whereSql = 'WHERE ' + where.join(' AND ')
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM shift_notes s ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT s.*, c.preferred_name AS client_preferred_name, bc.code AS billing_code
    FROM shift_notes s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN billing_codes bc ON bc.id = s.billing_code_id
    ${whereSql} ORDER BY s.shift_date DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset)
  return { rows: rows.map(toShift), total }
}

/**
 * Fetch one shift note (decrypted) with its photos, or throw 404.
 * @param {number} id
 */
export function getShift (id) {
  const row = sqlite.prepare('SELECT * FROM shift_notes WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Shift note not found')
  const shift = toShift(row)
  shift.photos = sqlite.prepare('SELECT id, original_name, mime_type, size_bytes, caption, created_at FROM shift_photos WHERE shift_note_id = ?').all(id)
  return shift
}

/**
 * Create a shift note attributed to the acting worker.
 * @param {object} data validated payload
 * @param {number} workerId
 */
export function createShift (data, workerId) {
  const ts = now()
  const duration = data.duration_hours ?? computeDuration(data.start_time, data.end_time)
  const cols = [...COLUMNS, 'worker_id', 'created_at', 'updated_at']
  const values = COLUMNS.map(c => {
    if (c === 'duration_hours') return duration
    const v = data[c] ?? null
    return ENCRYPTED.includes(c) ? encrypt(v) : v
  })
  const result = sqlite.prepare(`INSERT INTO shift_notes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...values, workerId, ts, ts)
  return getShift(result.lastInsertRowid)
}

/**
 * Update a shift note. Finalised notes only allow billing status changes,
 * unless the update sends `finalised: 0` to reopen the note for editing.
 * @param {number} id
 * @param {object} data
 */
export function updateShift (id, data) {
  const existing = getShift(id)
  if (existing.finalised && data.finalised !== 0) {
    const allowed = new Set(['billed', 'finalised'])
    data = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)))
    if (!Object.keys(data).length) throw new ApiError(409, 'FINALISED', 'Shift note is finalised; only billing status can change')
  }
  const sets = []
  const params = []
  for (const col of COLUMNS) {
    if (!(col in data) || col === 'client_id') continue
    sets.push(`${col} = ?`)
    params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
  }
  if (!sets.length) return existing
  sets.push('updated_at = ?')
  params.push(now(), id)
  sqlite.prepare(`UPDATE shift_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getShift(id)
}

/**
 * Soft-delete a shift note. Incident-flagged notes cannot be deleted.
 * @param {number} id
 */
export function deleteShift (id) {
  const shift = getShift(id)
  if (shift.incident_flag) throw new ApiError(409, 'INCIDENT_RETAINED', 'Incident-flagged shift notes cannot be deleted')
  sqlite.prepare('UPDATE shift_notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Attach an uploaded photo record to a shift note.
 * @param {number} shiftId
 * @param {{filename:string, originalname:string, mimetype:string, size:number}} file multer file
 * @param {string} [caption]
 */
export function addPhoto (shiftId, file, caption) {
  getShift(shiftId)
  const result = sqlite.prepare(`INSERT INTO shift_photos (shift_note_id, filename, original_name, mime_type, size_bytes, caption, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(shiftId, file.filename, file.originalname, file.mimetype, file.size, caption ?? null, now())
  return sqlite.prepare('SELECT id, original_name, mime_type, size_bytes, caption, created_at FROM shift_photos WHERE id = ?').get(result.lastInsertRowid)
}

/**
 * Fetch a photo row (incl. disk filename) ensuring it belongs to the shift.
 * @param {number} shiftId
 * @param {number} photoId
 */
export function getPhoto (shiftId, photoId) {
  const photo = sqlite.prepare('SELECT * FROM shift_photos WHERE id = ? AND shift_note_id = ?').get(photoId, shiftId)
  if (!photo) throw new ApiError(404, 'NOT_FOUND', 'Photo not found')
  return photo
}

/**
 * Delete a photo record (the row only; caller removes the file).
 * @param {number} shiftId
 * @param {number} photoId
 */
export function deletePhoto (shiftId, photoId) {
  const photo = getPhoto(shiftId, photoId)
  sqlite.prepare('DELETE FROM shift_photos WHERE id = ?').run(photoId)
  return photo
}
