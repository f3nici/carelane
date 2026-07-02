// clientDocumentService (metadata logic) now lives in `@carelane/core`.
// Re-exported here as bound functions so existing imports keep working. Only the
// on-disk storage directory (derived from server config) stays server-side.
import path from 'node:path'
import config from '../config.js'
import { services } from './_core.js'

export const {
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
} = services.clientDocument

/** Where completed/signed client documents live (served auth-gated only, never static). */
export const CLIENT_DOC_DIR = path.join(config.uploadPath, 'client-documents')
