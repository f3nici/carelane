import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'

const COLUMNS = ['client_id', 'report_type', 'period_start', 'period_end', 'body_markdown', 'source_shift_ids', 'status']

const now = () => new Date().toISOString()

/**
 * List reports with optional client / status filters.
 * @param {{page:number, perPage:number, offset:number}} pg
 * @param {{client_id?:string, status?:string}} filters
 */
export function listReports (pg, filters = {}) {
  const where = ['r.deleted_at IS NULL']
  const params = []
  if (filters.client_id) { where.push('r.client_id = ?'); params.push(Number(filters.client_id)) }
  if (filters.status) { where.push('r.status = ?'); params.push(filters.status) }
  const whereSql = 'WHERE ' + where.join(' AND ')
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM reports r ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT r.*, c.preferred_name AS client_preferred_name
    FROM reports r JOIN clients c ON c.id = r.client_id
    ${whereSql} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset)
  return { rows, total }
}

/**
 * Fetch one report or throw 404.
 * @param {number} id
 */
export function getReport (id) {
  const row = sqlite.prepare('SELECT * FROM reports WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Report not found')
  return row
}

/**
 * Create a report.
 * @param {object} data validated payload
 */
export function createReport (data) {
  const ts = now()
  const values = COLUMNS.map(c => {
    if (c === 'source_shift_ids') return data.source_shift_ids ? JSON.stringify(data.source_shift_ids) : null
    return data[c] ?? null
  })
  const cols = [...COLUMNS, 'created_at', 'updated_at']
  const result = sqlite.prepare(`INSERT INTO reports (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...values, ts, ts)
  return getReport(result.lastInsertRowid)
}

/**
 * Update a report. Finalised reports are locked.
 * @param {number} id
 * @param {object} data
 */
export function updateReport (id, data) {
  const existing = getReport(id)
  if (existing.status === 'final' && data.status !== 'draft') {
    throw new ApiError(409, 'FINALISED', 'Final reports cannot be edited')
  }
  const sets = []
  const params = []
  for (const col of COLUMNS) {
    if (!(col in data) || col === 'client_id') continue
    sets.push(`${col} = ?`)
    params.push(col === 'source_shift_ids'
      ? (data.source_shift_ids ? JSON.stringify(data.source_shift_ids) : null)
      : (data[col] ?? null))
  }
  if (!sets.length) return existing
  sets.push('updated_at = ?')
  params.push(now(), id)
  sqlite.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getReport(id)
}

/**
 * Store the rendered PDF filename against the report.
 * @param {number} id
 * @param {string} filename
 */
export function setReportPdf (id, filename) {
  sqlite.prepare('UPDATE reports SET pdf_filename = ?, updated_at = ? WHERE id = ?').run(filename, now(), id)
}

/**
 * Soft-delete a report (record retention — never hard-deleted).
 * @param {number} id
 */
export function deleteReport (id) {
  getReport(id)
  sqlite.prepare('UPDATE reports SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}
