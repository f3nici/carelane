import { sqlite } from '../db/connection.js'
import { clientDisplayName } from './clientService.js'
import { ApiError } from '../middleware/errorHandler.js'

const COLUMNS = ['client_id', 'title', 'status', 'start_date', 'end_date', 'review_date',
  'supports_summary', 'hourly_rate', 'total_budget', 'questionnaire_json', 'body_markdown']

const now = () => new Date().toISOString()

/**
 * The date that makes an active agreement "due for attention" within a window:
 * the soonest of its end date and review date that falls in [today, soon]. Lets
 * an open-ended agreement (no end date) still surface on its review date, and
 * keeps the dashboard widget and the ntfy nudge in agreement on which date and
 * label to show. Falls back to whichever date exists when neither is in-window.
 * @param {{end_date?:string, review_date?:string}} row
 * @param {string} today ISO date (inclusive lower bound)
 * @param {string} soon ISO date (inclusive upper bound)
 * @returns {{due_date:string|null, due_type:('end'|'review'|null)}}
 */
export function agreementDueDate (row, today, soon) {
  // 'review' first so it wins a same-date tie (a review is the gentler nudge).
  const inWindow = [['review', row.review_date], ['end', row.end_date]]
    .filter(([, d]) => d && d >= today && d <= soon)
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
  if (inWindow.length) return { due_date: inWindow[0][1], due_type: inWindow[0][0] }
  return {
    due_date: row.end_date || row.review_date || null,
    due_type: row.end_date ? 'end' : (row.review_date ? 'review' : null)
  }
}

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
 * List service agreements with optional client / status / archived filters. By
 * default archived agreements are hidden; pass `archived: 'true'` for archived
 * only, or `archived: 'all'` for both.
 * @param {{page:number, perPage:number, offset:number}} pg
 * @param {{client_id?:string, status?:string, archived?:string}} filters
 */
export function listAgreements (pg, filters = {}) {
  const where = ['a.deleted_at IS NULL']
  const params = []
  if (filters.archived === 'true' || filters.archived === '1') where.push('a.archived_at IS NOT NULL')
  else if (filters.archived !== 'all') where.push('a.archived_at IS NULL')
  if (filters.client_id) { where.push('a.client_id = ?'); params.push(Number(filters.client_id)) }
  if (filters.status) { where.push('a.status = ?'); params.push(filters.status) }
  const whereSql = 'WHERE ' + where.join(' AND ')
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM service_agreements a ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT a.*, c.preferred_name AS client_preferred_name,
      c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM service_agreements a JOIN clients c ON c.id = a.client_id
    ${whereSql} ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset)
  return { rows: rows.map(toListRow), total }
}

/**
 * Fetch one agreement with its line items, or throw 404.
 * @param {number} id
 */
export function getAgreement (id) {
  const row = sqlite.prepare('SELECT * FROM service_agreements WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agreement not found')
  row.line_items = sqlite.prepare(`SELECT li.*, bc.code, bc.name AS code_name, bc.unit
    FROM agreement_line_items li LEFT JOIN billing_codes bc ON bc.id = li.billing_code_id
    WHERE li.agreement_id = ?`).all(id)
  return row
}

function setLineItems (agreementId, items) {
  sqlite.prepare('DELETE FROM agreement_line_items WHERE agreement_id = ?').run(agreementId)
  const insert = sqlite.prepare(`INSERT INTO agreement_line_items
    (agreement_id, billing_code_id, description, unit_price, estimated_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
  for (const it of items) {
    insert.run(agreementId, it.billing_code_id ?? null, it.description ?? null,
      it.unit_price ?? null, it.estimated_quantity ?? null, now())
  }
}

function serialiseQuestionnaire (data) {
  if (data.questionnaire_json && typeof data.questionnaire_json === 'object') {
    return JSON.stringify(data.questionnaire_json)
  }
  return data.questionnaire_json ?? null
}

/**
 * Create an agreement (optionally with line items).
 * @param {object} data validated payload
 */
export function createAgreement (data) {
  const ts = now()
  const values = COLUMNS.map(c => c === 'questionnaire_json' ? serialiseQuestionnaire(data) : (data[c] ?? null))
  const cols = [...COLUMNS, 'created_at', 'updated_at']
  const tx = sqlite.transaction(() => {
    const result = sqlite.prepare(`INSERT INTO service_agreements (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values, ts, ts)
    if (data.line_items?.length) setLineItems(result.lastInsertRowid, data.line_items)
    return result.lastInsertRowid
  })
  return getAgreement(tx())
}

/**
 * Update an agreement. Signed agreements lock their body and terms; only
 * status transitions are allowed.
 * @param {number} id
 * @param {object} data
 */
export function updateAgreement (id, data) {
  const existing = getAgreement(id)
  if (existing.signed_by_client) {
    const allowed = new Set(['status'])
    data = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)))
    if (!Object.keys(data).length) throw new ApiError(409, 'SIGNED', 'Signed agreements can only change status')
  }
  const sets = []
  const params = []
  for (const col of COLUMNS) {
    if (!(col in data) || col === 'client_id') continue
    sets.push(`${col} = ?`)
    params.push(col === 'questionnaire_json' ? serialiseQuestionnaire(data) : (data[col] ?? null))
  }
  const tx = sqlite.transaction(() => {
    if (sets.length) {
      sets.push('updated_at = ?')
      params.push(now(), id)
      sqlite.prepare(`UPDATE service_agreements SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }
    if (data.line_items) setLineItems(id, data.line_items)
  })
  tx()
  return getAgreement(id)
}

/**
 * Mark an agreement as signed by the participant (human action — never AI).
 * @param {number} id
 * @param {string} [signedDate] ISO date, defaults to today
 */
export function signAgreement (id, signedDate) {
  const a = getAgreement(id)
  if (!a.body_markdown) throw new ApiError(409, 'NO_BODY', 'Agreement has no body to sign')
  sqlite.prepare('UPDATE service_agreements SET signed_by_client = 1, signed_date = ?, status = \'active\', updated_at = ? WHERE id = ?')
    .run(signedDate || now().slice(0, 10), now(), id)
  return getAgreement(id)
}

/**
 * Store the rendered PDF filename against the agreement.
 * @param {number} id
 * @param {string} filename
 */
export function setAgreementPdf (id, filename) {
  sqlite.prepare('UPDATE service_agreements SET pdf_filename = ?, updated_at = ? WHERE id = ?').run(filename, now(), id)
}

/**
 * Soft-delete an agreement (record retention — never hard-deleted).
 * @param {number} id
 */
export function deleteAgreement (id) {
  getAgreement(id)
  sqlite.prepare('UPDATE service_agreements SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Archive an agreement (hide it from active lists without deleting it).
 * @param {number} id
 */
export function archiveAgreement (id) {
  getAgreement(id)
  sqlite.prepare('UPDATE service_agreements SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  return getAgreement(id)
}

/**
 * Unarchive an agreement (return it to the active list).
 * @param {number} id
 */
export function unarchiveAgreement (id) {
  getAgreement(id)
  sqlite.prepare('UPDATE service_agreements SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  return getAgreement(id)
}

/**
 * Restore a soft-deleted agreement. Throws 404 if it does not exist or is not
 * currently deleted.
 * @param {number} id
 */
export function restoreAgreement (id) {
  const row = sqlite.prepare('SELECT id FROM service_agreements WHERE id = ? AND deleted_at IS NOT NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted agreement not found')
  sqlite.prepare('UPDATE service_agreements SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  return getAgreement(id)
}
