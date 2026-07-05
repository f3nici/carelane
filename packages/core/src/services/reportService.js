import { ApiError } from '../errors.js'
import { applyClientScope } from '../utils/sql.js'

/**
 * Build the report service bound to a host context.
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services
 */
export function createReportService (ctx, services) {
  const { sqlite } = ctx
  const { clientDisplayName } = services.client

  const COLUMNS = ['client_id', 'report_type', 'period_start', 'period_end', 'body_markdown', 'source_shift_ids', 'status']

  const now = () => new Date(ctx.now()).toISOString()

  /**
   * Add `client_display_name` to a list row and drop the raw joined name columns.
   */
  function toListRow (row) {
    row.client_display_name = clientDisplayName(row)
    delete row.client_first_name
    delete row.client_last_name
    return row
  }

  /**
   * List reports with optional client / status / archived filters. By default
   * archived reports are hidden; pass `archived: 'true'` for archived only, or
   * `archived: 'all'` for both.
   * @param {{page:number, perPage:number, offset:number}} pg
   * @param {{client_id?:string, status?:string, archived?:string}} filters
   */
  function listReports (pg, filters = {}) {
    const where = ['r.deleted_at IS NULL']
    const params = []
    applyClientScope(where, params, 'r.client_id', filters.client_ids)
    if (filters.archived === 'true' || filters.archived === '1') where.push('r.archived_at IS NOT NULL')
    else if (filters.archived !== 'all') where.push('r.archived_at IS NULL')
    if (filters.client_id) { where.push('r.client_id = ?'); params.push(Number(filters.client_id)) }
    if (filters.status) { where.push('r.status = ?'); params.push(filters.status) }
    const whereSql = 'WHERE ' + where.join(' AND ')
    const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM reports r ${whereSql}`).get(...params).c
    const rows = sqlite.prepare(`SELECT r.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name
      FROM reports r JOIN clients c ON c.id = r.client_id
      ${whereSql} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pg.perPage, pg.offset)
    return { rows: rows.map(toListRow), total }
  }

  /**
   * Fetch one report or throw 404.
   * @param {number} id
   */
  function getReport (id) {
    const row = sqlite.prepare('SELECT * FROM reports WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Report not found')
    return row
  }

  /**
   * Create a report.
   * @param {object} data validated payload
   */
  function createReport (data) {
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
  function updateReport (id, data) {
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
  function setReportPdf (id, filename) {
    sqlite.prepare('UPDATE reports SET pdf_filename = ?, updated_at = ? WHERE id = ?').run(filename, now(), id)
  }

  /**
   * Soft-delete a report (record retention — never hard-deleted).
   * @param {number} id
   */
  function deleteReport (id) {
    getReport(id)
    sqlite.prepare('UPDATE reports SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Archive a report (hide it from active lists without deleting it).
   * @param {number} id
   */
  function archiveReport (id) {
    getReport(id)
    sqlite.prepare('UPDATE reports SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return getReport(id)
  }

  /**
   * Unarchive a report (return it to the active list).
   * @param {number} id
   */
  function unarchiveReport (id) {
    getReport(id)
    sqlite.prepare('UPDATE reports SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getReport(id)
  }

  /**
   * Restore a soft-deleted report. Throws 404 if it does not exist or is not
   * currently deleted.
   * @param {number} id
   */
  function restoreReport (id) {
    const row = sqlite.prepare('SELECT id FROM reports WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted report not found')
    sqlite.prepare('UPDATE reports SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getReport(id)
  }

  return {
    listReports,
    getReport,
    createReport,
    updateReport,
    setReportPdf,
    deleteReport,
    archiveReport,
    unarchiveReport,
    restoreReport
  }
}
