import crypto from 'node:crypto'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { ApiError } from '../middleware/errorHandler.js'
import { getReport } from './reportService.js'
import { getClientDocument } from './clientDocumentService.js'
import { getClient } from './clientService.js'
import { logActivity } from './activityService.js'

/**
 * Client-facing share links. A share link is a time-limited, audited, read-only
 * URL that lets a plan manager (or the participant themselves) fetch ONE
 * specific finalised report or completed document without a CareLane account.
 *
 * Design mirrors the calendar feed: the unguessable token in the URL is the only
 * credential (no cookie/OAuth), so the public endpoint is served OUTSIDE the
 * session + CSRF stack and the token path is redacted from the access log. Where
 * this goes further:
 *  - a link is bound to a single resource + participant, never the whole record;
 *  - it carries an `expires_at` (and an optional `max_views` cap), so access is
 *    time-limited by construction;
 *  - every fetch is counted (`view_count`/`last_viewed_at`) and written to the
 *    append-only audit trail, so an operator can see exactly when a shared item
 *    was retrieved;
 *  - links are revoked (soft), never hard-deleted, so the audit history of a
 *    shared item stays intact.
 *
 * Only finalised reports and completed documents may be shared — a draft is
 * never exposed externally (enforced at creation).
 */

/** Resource types a link can point at. */
const RESOURCE_TYPES = ['report', 'client_document']

/**
 * The public base URL of this install for building a share URL. Prefers the
 * configured `APP_BASE_URL`; otherwise derives it from the incoming request so a
 * same-origin deployment needs no extra config (mirrors calendarFeedService).
 * @param {import('express').Request} req
 */
function baseUrl (req) {
  if (config.appBaseUrl) return config.appBaseUrl
  return `${req.protocol}://${req.get('host')}`
}

/** The absolute public URL for a share token. */
export function shareUrl (token, req) {
  return `${baseUrl(req)}/share/${token}`
}

/**
 * Compute a link's live state without mutating it.
 *  - `revoked`   — an operator revoked it;
 *  - `expired`   — past its `expires_at`;
 *  - `exhausted` — hit its `max_views` cap;
 *  - `active`    — still usable.
 * @param {object} row a share_links row
 * @param {number} [nowMs] current epoch ms (injectable for tests)
 * @returns {'revoked'|'expired'|'exhausted'|'active'}
 */
export function linkState (row, nowMs = Date.now()) {
  if (row.revoked_at) return 'revoked'
  if (row.max_views != null && row.view_count >= row.max_views) return 'exhausted'
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return 'expired'
  return 'active'
}

/**
 * Resolve the shared resource and confirm it belongs to the given participant.
 * Also enforces that the resource is in a shareable state (a report must be
 * finalised). Throws an ApiError otherwise.
 * @param {string} resourceType
 * @param {number} resourceId
 * @param {number} clientId
 * @returns {{ title:string }} a short, safe descriptor of the resource
 */
function resolveResource (resourceType, resourceId, clientId) {
  if (resourceType === 'report') {
    const report = getReport(resourceId)
    if (report.client_id !== clientId) throw new ApiError(400, 'VALIDATION_ERROR', 'Report does not belong to this participant')
    if (report.status !== 'final') throw new ApiError(409, 'NOT_FINAL', 'Only finalised reports can be shared')
    return { title: `${report.report_type.replace('_', ' ')} report` }
  }
  if (resourceType === 'client_document') {
    // getClientDocument scopes by client_id, so a mismatch throws 404 here.
    const doc = getClientDocument(clientId, resourceId)
    // Only PDF documents are shareable — an image or other file type is never
    // exposed through a public link.
    if (doc.mime_type !== 'application/pdf') {
      throw new ApiError(409, 'NOT_PDF', 'Only PDF documents can be shared')
    }
    return { title: doc.title || 'Document' }
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown resource type')
}

/**
 * A short, privacy-preserving participant label for a link (preferred name, or
 * initials) — mirrors how the calendar feed / AI calls minimise what leaves the
 * record. Never the participant's full legal name.
 * @param {number} clientId
 */
function participantLabel (clientId) {
  const client = getClient(clientId)
  return client.preferred_name ||
    `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase() ||
    `Participant #${clientId}`
}

/**
 * Decorate a raw row with its live state and a couple of derived fields for the
 * management UI. Never includes any resource content — just metadata.
 * @param {object} row
 */
function toManageRow (row) {
  const state = linkState(row)
  return {
    id: row.id,
    token: row.token,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    client_id: row.client_id,
    label: row.label,
    expires_at: row.expires_at,
    max_views: row.max_views,
    view_count: row.view_count,
    last_viewed_at: row.last_viewed_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by: row.created_by,
    state,
    active: state === 'active'
  }
}

/**
 * Create a share link for a report or document. Validates the resource exists,
 * belongs to the participant and is shareable, then mints an unguessable token.
 * @param {{resource_type:string, resource_id:number, client_id:number, label:?string, expires_in_days:number, max_views:?number}} data validated payload
 * @param {number} userId acting operator (for audit + created_by)
 * @param {import('express').Request} req for building the absolute URL
 * @returns {object} the created link (management shape) plus its `url`
 */
export function createShareLink (data, userId, req) {
  if (!RESOURCE_TYPES.includes(data.resource_type)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown resource type')
  }
  resolveResource(data.resource_type, data.resource_id, data.client_id)

  const now = new Date()
  const expiresAt = new Date(now.getTime() + data.expires_in_days * 86400000).toISOString()
  const token = crypto.randomBytes(24).toString('base64url')
  const ts = now.toISOString()

  const result = sqlite.prepare(`INSERT INTO share_links
      (token, resource_type, resource_id, client_id, label, created_by, expires_at, max_views, view_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(token, data.resource_type, data.resource_id, data.client_id, data.label ?? null,
      userId ?? null, expiresAt, data.max_views ?? null, ts, ts)

  const row = sqlite.prepare('SELECT * FROM share_links WHERE id = ?').get(result.lastInsertRowid)
  logActivity('share_link', row.id, userId, 'created', {
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    client_id: row.client_id,
    expires_at: row.expires_at,
    max_views: row.max_views
  })
  return { ...toManageRow(row), url: shareUrl(token, req) }
}

/**
 * List share links, newest first, decorated with live state and the (safe)
 * participant + resource labels. Optionally filtered to one resource or one
 * participant.
 * @param {{resource_type?:string, resource_id?:number, client_id?:number}} [filters]
 * @param {import('express').Request} req for building absolute URLs
 * @returns {object[]}
 */
export function listShareLinks (filters = {}, req) {
  const where = []
  const params = []
  if (filters.resource_type) { where.push('resource_type = ?'); params.push(filters.resource_type) }
  if (filters.resource_id) { where.push('resource_id = ?'); params.push(Number(filters.resource_id)) }
  if (filters.client_id) { where.push('client_id = ?'); params.push(Number(filters.client_id)) }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = sqlite.prepare(`SELECT * FROM share_links ${whereSql} ORDER BY id DESC`).all(...params)
  return rows.map(row => ({
    ...toManageRow(row),
    url: shareUrl(row.token, req),
    participant_label: participantLabel(row.client_id)
  }))
}

/**
 * Fetch one link by id or throw 404.
 * @param {number} id
 */
export function getShareLink (id) {
  const row = sqlite.prepare('SELECT * FROM share_links WHERE id = ?').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Share link not found')
  return row
}

/**
 * Revoke a link (soft): existing URLs stop working immediately. Idempotent — a
 * second revoke is a no-op. Never hard-deleted, so the audit history stays.
 * @param {number} id
 * @param {number} userId acting operator
 * @param {import('express').Request} req
 * @returns {object} the updated link (management shape)
 */
export function revokeShareLink (id, userId, req) {
  const row = getShareLink(id)
  if (!row.revoked_at) {
    const ts = new Date().toISOString()
    sqlite.prepare('UPDATE share_links SET revoked_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id)
    logActivity('share_link', id, userId, 'revoked', { resource_type: row.resource_type, resource_id: row.resource_id })
  }
  const updated = getShareLink(id)
  return { ...toManageRow(updated), url: shareUrl(updated.token, req), participant_label: participantLabel(updated.client_id) }
}

/**
 * Resolve a public token to its link row and live state. Never throws — the
 * public route decides what (friendly) response each state gets. Returns null
 * for an unknown token.
 * @param {string} token
 * @returns {{ link:object, state:string }|null}
 */
export function resolveByToken (token) {
  if (!token || typeof token !== 'string') return null
  const row = sqlite.prepare('SELECT * FROM share_links WHERE token = ?').get(token)
  if (!row) return null
  return { link: row, state: linkState(row) }
}

/**
 * Public-facing, safe description of what a link points at, for the landing
 * page. Deliberately minimal — a short participant label + a resource title,
 * never any report/health content.
 * @param {object} link a share_links row
 */
export function describeLink (link) {
  const { title } = resolveResource(link.resource_type, link.resource_id, link.client_id)
  return {
    title,
    participant_label: participantLabel(link.client_id),
    expires_at: link.expires_at,
    views_remaining: link.max_views == null ? null : Math.max(0, link.max_views - link.view_count)
  }
}

/**
 * Record a successful fetch: bump the view counter, stamp last-viewed and write
 * an audit entry. Called by the public download once content is confirmed
 * available. The audit row carries no PII (ids + type only) and no acting user
 * (the fetch is external/anonymous).
 * @param {object} link a share_links row
 */
export function recordAccess (link) {
  const ts = new Date().toISOString()
  sqlite.prepare('UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, link.id)
  logActivity('share_link', link.id, null, 'accessed', {
    resource_type: link.resource_type,
    resource_id: link.resource_id,
    client_id: link.client_id
  })
}
