import path from 'node:path'
import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const now = () => new Date().toISOString()

/** Where completed/signed client documents live (served auth-gated only, never static). */
export const CLIENT_DOC_DIR = path.join(config.uploadPath, 'client-documents')

const SOURCE_TYPES = new Set(['agreement', 'report', 'upload'])

/**
 * List a client's completed documents (newest first), excluding archived ones.
 * The on-disk filename is intentionally not returned — files are reached only
 * through the auth-gated download route.
 * @param {number} clientId
 * @returns {object[]}
 */
export function listClientDocuments (clientId) {
  return sqlite.prepare(`SELECT id, client_id, title, source_type, source_id, original_name, mime_type, size_bytes, created_at
    FROM client_documents WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`).all(clientId)
}

/**
 * Fetch one completed document for a client, or throw 404.
 * @param {number} clientId
 * @param {number} id
 * @returns {object}
 */
export function getClientDocument (clientId, id) {
  const row = sqlite.prepare('SELECT * FROM client_documents WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(id, clientId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Document not found')
  return row
}

/**
 * Store an uploaded completed document (e.g. a signed agreement or finalised
 * report PDF) against a client.
 * @param {number} clientId
 * @param {{filename:string, originalname:string, mimetype:string, size:number}} file multer file
 * @param {{title?:string, source_type?:string, source_id?:number|string}} meta
 * @returns {object} the stored document row
 */
export function createClientDocument (clientId, file, meta = {}) {
  const sourceType = SOURCE_TYPES.has(meta.source_type) ? meta.source_type : 'upload'
  const sourceId = meta.source_id ? (Number(meta.source_id) || null) : null
  const title = String(meta.title || file.originalname || 'Document').trim().slice(0, 200)
  const result = sqlite.prepare(`INSERT INTO client_documents
    (client_id, title, source_type, source_id, filename, original_name, mime_type, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, title, sourceType, sourceId, file.filename, file.originalname, file.mimetype, file.size, now())
  return getClientDocument(clientId, result.lastInsertRowid)
}

/**
 * Archive (soft-delete) a completed document. These are regulated participant
 * records, so the row is hidden but never hard-deleted and the file is kept.
 * @param {number} clientId
 * @param {number} id
 */
export function deleteClientDocument (clientId, id) {
  getClientDocument(clientId, id)
  sqlite.prepare('UPDATE client_documents SET deleted_at = ? WHERE id = ?').run(now(), id)
}
