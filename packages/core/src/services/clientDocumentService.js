import { ApiError } from '../errors.js'
import { applyClientScope } from '../utils/sql.js'

/**
 * Build the client-document metadata service bound to a host context. File
 * storage paths (CLIENT_DOC_DIR) stay server-side; this handles the trackable
 * metadata (types, issue/expiry dates, expiry status).
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services
 */
export function createClientDocumentService (ctx, services) {
  const { sqlite } = ctx
  const { clientDisplayName } = services.client

  const now = () => new Date(ctx.now()).toISOString()
  const today = () => new Date(ctx.now()).toISOString().slice(0, 10)

  const SOURCE_TYPES = new Set(['agreement', 'report', 'upload'])

  /**
   * First-class document types. Consent forms and other expirable paperwork are
   * promoted out of generic "uploads" so they can be classified, surfaced before
   * they lapse, and produced cleanly during an audit. Kept in sync with the
   * `clientDocumentMetaSchema` enum in validators.js and the front-end labels.
   */
  const DOC_TYPES = new Set([
    'media_consent', 'consent_to_share', 'consent_general', 'service_agreement',
    'behaviour_support_plan', 'risk_assessment', 'insurance', 'identification', 'other'
  ])

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

  /** Coerce/validate an ISO date string, or null. */
  function cleanDate (value) {
    const v = String(value || '').trim()
    return ISO_DATE.test(v) ? v : null
  }

  /**
   * Classify a document by its expiry date relative to today. `expiring` covers
   * anything lapsing within `withinDays` (default 30); past dates are `expired`.
   * Documents with no expiry date return null (nothing to track).
   * @param {string|null} expiryDate ISO date
   * @param {number} [withinDays]
   * @returns {'expired'|'expiring'|'ok'|null}
   */
  function expiryStatus (expiryDate, withinDays = 30) {
    if (!expiryDate) return null
    const d = today()
    if (expiryDate < d) return 'expired'
    const soon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return expiryDate <= soon ? 'expiring' : 'ok'
  }

  /** Attach the computed expiry_status to a document row. */
  function withExpiry (row) {
    return row && { ...row, expiry_status: expiryStatus(row.expiry_date) }
  }

  /**
   * List a client's completed documents (newest expiry-relevant first), excluding
   * archived ones. The on-disk filename is intentionally not returned — files are
   * reached only through the auth-gated download route.
   * @param {number} clientId
   * @returns {object[]}
   */
  function listClientDocuments (clientId) {
    return sqlite.prepare(`SELECT id, client_id, title, source_type, source_id, doc_type, issue_date, expiry_date,
        original_name, mime_type, size_bytes, created_at, updated_at
      FROM client_documents WHERE client_id = ? AND deleted_at IS NULL
      ORDER BY (expiry_date IS NULL), expiry_date, created_at DESC`).all(clientId).map(withExpiry)
  }

  /**
   * Fetch one completed document for a client, or throw 404.
   * @param {number} clientId
   * @param {number} id
   * @returns {object}
   */
  function getClientDocument (clientId, id) {
    const row = sqlite.prepare('SELECT * FROM client_documents WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(id, clientId)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Document not found')
    return withExpiry(row)
  }

  /**
   * Store an uploaded completed document (e.g. a signed agreement, finalised
   * report PDF, or a consent form) against a client.
   * @param {number} clientId
   * @param {{filename:string, originalname:string, mimetype:string, size:number}} file multer file
   * @param {{title?:string, source_type?:string, source_id?:number|string, doc_type?:string, issue_date?:string, expiry_date?:string}} meta
   * @returns {object} the stored document row
   */
  function createClientDocument (clientId, file, meta = {}) {
    const sourceType = SOURCE_TYPES.has(meta.source_type) ? meta.source_type : 'upload'
    const sourceId = meta.source_id ? (Number(meta.source_id) || null) : null
    const docType = DOC_TYPES.has(meta.doc_type) ? meta.doc_type : 'other'
    const title = String(meta.title || file.originalname || 'Document').trim().slice(0, 200)
    const ts = now()
    const result = sqlite.prepare(`INSERT INTO client_documents
      (client_id, title, source_type, source_id, doc_type, issue_date, expiry_date, filename, original_name, mime_type, size_bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(clientId, title, sourceType, sourceId, docType, cleanDate(meta.issue_date), cleanDate(meta.expiry_date),
        file.filename, file.originalname, file.mimetype, file.size, ts, ts)
    return getClientDocument(clientId, result.lastInsertRowid)
  }

  /**
   * Update a document's metadata (title, type, issue/expiry dates) without
   * re-uploading the file — e.g. recording an expiry on an older upload or
   * re-classifying a generic upload as a consent form.
   * @param {number} clientId
   * @param {number} id
   * @param {{title?:string, doc_type?:string, issue_date?:string|null, expiry_date?:string|null}} meta validated metadata
   * @returns {object} the updated document row
   */
  function updateClientDocument (clientId, id, meta = {}) {
    getClientDocument(clientId, id)
    const sets = []
    const params = []
    if ('title' in meta) { sets.push('title = ?'); params.push(String(meta.title || 'Document').trim().slice(0, 200)) }
    if ('doc_type' in meta) { sets.push('doc_type = ?'); params.push(DOC_TYPES.has(meta.doc_type) ? meta.doc_type : 'other') }
    if ('issue_date' in meta) { sets.push('issue_date = ?'); params.push(cleanDate(meta.issue_date)) }
    if ('expiry_date' in meta) { sets.push('expiry_date = ?'); params.push(cleanDate(meta.expiry_date)) }
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE client_documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return getClientDocument(clientId, id)
  }

  /**
   * Documents that have expired or are due to expire within `withinDays` days,
   * across all active clients — for the dashboard "expiring soon" surfacing.
   * Returns the participant display name (operator-facing view), never written
   * back to the PII-redacted audit log.
   * @param {number} [withinDays]
   * @param {number[]} [clientIds] restrict to these participants (worker scope)
   * @returns {object[]}
   */
  function listExpiringDocuments (withinDays = 90, clientIds) {
    const soon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const where = ['d.deleted_at IS NULL AND c.deleted_at IS NULL AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?']
    const params = [soon]
    applyClientScope(where, params, 'd.client_id', clientIds)
    const rows = sqlite.prepare(`SELECT d.id, d.client_id, d.title, d.doc_type, d.expiry_date,
        c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
      FROM client_documents d JOIN clients c ON c.id = d.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.expiry_date`).all(...params)
    return rows.map(({ client_first_name, client_last_name, ...r }) => ({
      ...r,
      expiry_status: expiryStatus(r.expiry_date),
      client_display_name: clientDisplayName({
        first_name: client_first_name, last_name: client_last_name, preferred_name: r.client_preferred_name, id: r.client_id
      })
    }))
  }

  /**
   * Count of expired + soon-to-expire documents (dashboard headline stat).
   * @param {number} [withinDays]
   * @param {number[]} [clientIds] restrict to these participants (worker scope)
   */
  function countExpiringDocuments (withinDays = 90, clientIds) {
    const soon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const where = ['d.deleted_at IS NULL AND c.deleted_at IS NULL AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?']
    const params = [soon]
    applyClientScope(where, params, 'd.client_id', clientIds)
    return sqlite.prepare(`SELECT COUNT(*) AS c FROM client_documents d JOIN clients c ON c.id = d.client_id
      WHERE ${where.join(' AND ')}`).get(...params).c
  }

  /**
   * Archive (soft-delete) a completed document. These are regulated participant
   * records, so the row is hidden but never hard-deleted and the file is kept.
   * @param {number} clientId
   * @param {number} id
   */
  function deleteClientDocument (clientId, id) {
    getClientDocument(clientId, id)
    sqlite.prepare('UPDATE client_documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Restore a soft-deleted document (for the Deleted-items recycle bin). Looked up
   * by id alone since the restore registry is keyed by type+id.
   * @param {number} id
   * @returns {object}
   */
  function restoreClientDocument (id) {
    const row = sqlite.prepare('SELECT client_id FROM client_documents WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted document not found')
    sqlite.prepare('UPDATE client_documents SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getClientDocument(row.client_id, id)
  }

  return {
    expiryStatus,
    listClientDocuments,
    getClientDocument,
    createClientDocument,
    updateClientDocument,
    listExpiringDocuments,
    countExpiringDocuments,
    deleteClientDocument,
    restoreClientDocument,
    DOC_TYPES
  }
}
