import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import { services } from './_core.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Client-portal service. Two concerns, both deliberately in one place so the
 * exact shape of what a participant login can reach is auditable at a glance:
 *
 *  1. Account management (admin-facing) — create/update/reset/deactivate the
 *     single portal login attached to a participant. Credentials are a username
 *     + bcrypt password hash (cost 12, matching the staff `users` table); the
 *     hash is never returned to any API caller.
 *  2. Data reads (participant-facing) — the read-only slice a logged-in
 *     participant may see: their OWN finalised shift notes (rendered narrative,
 *     never billing or the sensitive `incident_details` field) and their own
 *     completed documents. Every read is scoped to the account's `client_id`, so
 *     a portal session can never reach another participant's records.
 *
 * A portal session stores only `req.session.portalClientId` — never a staff
 * `userId` — so a portal credential can never satisfy the staff auth middleware.
 */

const BCRYPT_COST = 12
const nowIso = () => new Date().toISOString()

const { crypto: cryptoService, client: clientService } = services
const { decrypt } = cryptoService

/** Shape the account row for an API response (never leak the password hash). */
function toAccount (row) {
  if (!row) return null
  return {
    id: row.id,
    client_id: row.client_id,
    username: row.username,
    active: !!row.active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/**
 * Fetch the portal account for a participant (without the hash), or null.
 * @param {number} clientId
 */
export function getAccountForClient (clientId) {
  return toAccount(sqlite.prepare('SELECT * FROM client_portal_accounts WHERE client_id = ?').get(clientId))
}

/**
 * Create or update the participant's portal account. A username is always
 * required; a password is required when creating the account and optional (only
 * changed when supplied) when updating. `active` toggles access.
 * @param {number} clientId
 * @param {{username:string, password?:string, active?:number}} data
 * @returns {object} the account (no hash)
 */
export function upsertAccount (clientId, data) {
  // The participant must exist (and not be soft-deleted) before it gets a login.
  clientService.getClient(clientId)
  const existing = sqlite.prepare('SELECT * FROM client_portal_accounts WHERE client_id = ?').get(clientId)

  // Usernames are globally unique across portal accounts — reject a collision
  // with a *different* participant's login up front for a clear error.
  const clash = sqlite.prepare('SELECT client_id FROM client_portal_accounts WHERE username = ?').get(data.username)
  if (clash && clash.client_id !== clientId) {
    throw new ApiError(409, 'USERNAME_TAKEN', 'That portal username is already in use')
  }

  const ts = nowIso()
  if (existing) {
    const active = data.active == null ? existing.active : (data.active ? 1 : 0)
    if (data.password) {
      sqlite.prepare('UPDATE client_portal_accounts SET username = ?, password_hash = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(data.username, bcrypt.hashSync(data.password, BCRYPT_COST), active, ts, existing.id)
    } else {
      sqlite.prepare('UPDATE client_portal_accounts SET username = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(data.username, active, ts, existing.id)
    }
    return getAccountForClient(clientId)
  }

  if (!data.password) throw new ApiError(400, 'PASSWORD_REQUIRED', 'Set a password for the new portal account')
  const active = data.active == null ? 1 : (data.active ? 1 : 0)
  sqlite.prepare(`INSERT INTO client_portal_accounts (client_id, username, password_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(clientId, data.username, bcrypt.hashSync(data.password, BCRYPT_COST), active, ts, ts)
  return getAccountForClient(clientId)
}

/**
 * Reset a portal account's password. Also destroys its live sessions so a reset
 * (often prompted by suspected compromise) revokes any existing portal session.
 * @param {number} clientId
 * @param {string} newPassword
 */
export function resetPassword (clientId, newPassword) {
  const existing = sqlite.prepare('SELECT id FROM client_portal_accounts WHERE client_id = ?').get(clientId)
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No portal account for this participant')
  sqlite.prepare('UPDATE client_portal_accounts SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, BCRYPT_COST), nowIso(), existing.id)
  destroySessionsForClient(clientId)
}

/**
 * Remove a participant's portal account entirely (revokes access). A portal
 * account is an access credential, not a regulated health record, so a hard
 * delete is appropriate — the participant's notes/documents are untouched.
 * @param {number} clientId
 */
export function deleteAccount (clientId) {
  const existing = sqlite.prepare('SELECT id FROM client_portal_accounts WHERE client_id = ?').get(clientId)
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No portal account for this participant')
  sqlite.prepare('DELETE FROM client_portal_accounts WHERE id = ?').run(existing.id)
  destroySessionsForClient(clientId)
}

/**
 * Destroy every persisted session belonging to a participant's portal login.
 * Operates on the better-sqlite3-session-store `sessions` table; the portal
 * client id lives inside the JSON `sess` blob. A no-op if the store table has
 * not been created yet (e.g. before the first request in a fresh test DB).
 * @param {number} clientId
 * @returns {number} sessions removed
 */
export function destroySessionsForClient (clientId) {
  try {
    return sqlite.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.portalClientId') = ?").run(clientId).changes
  } catch {
    return 0
  }
}

/**
 * Verify portal login credentials. Returns the account row (incl. client_id) on
 * success, or null on any failure (unknown user, wrong password, inactive
 * account, or the participant deactivated/deleted). Always runs a bcrypt compare
 * so a missing username costs the same as a wrong password.
 * @param {string} username
 * @param {string} password
 * @returns {object|null}
 */
export function verifyLogin (username, password) {
  const account = sqlite.prepare('SELECT * FROM client_portal_accounts WHERE username = ?').get(username)
  const passwordOk = bcrypt.compareSync(password, account ? account.password_hash : DUMMY_HASH)
  if (!account || !passwordOk || !account.active) return null
  // The underlying participant must still be active and not soft-deleted.
  const client = sqlite.prepare('SELECT id, active, deleted_at FROM clients WHERE id = ?').get(account.client_id)
  if (!client || !client.active || client.deleted_at) return null
  return account
}

// Precomputed hash compared against when the username is unknown, so login
// timing does not reveal which portal usernames exist.
const DUMMY_HASH = bcrypt.hashSync('carelane-portal-timing-equaliser', BCRYPT_COST)

/** Stamp the last-login time on a portal account. */
export function touchLogin (accountId) {
  sqlite.prepare('UPDATE client_portal_accounts SET last_login_at = ? WHERE id = ?').run(nowIso(), accountId)
}

/**
 * Load the live portal-session context: the account + participant, re-read on
 * every request so a deactivation takes effect immediately (mirroring the staff
 * `attachAccess`). Returns null if the account or participant is no longer valid.
 * @param {number} clientId
 * @returns {{ accountId:number, clientId:number, username:string, participantLabel:string }|null}
 */
export function loadPortalContext (clientId) {
  const account = sqlite.prepare('SELECT * FROM client_portal_accounts WHERE client_id = ?').get(clientId)
  if (!account || !account.active) return null
  const client = sqlite.prepare('SELECT id, preferred_name, first_name, last_name, active, deleted_at FROM clients WHERE id = ?').get(clientId)
  if (!client || !client.active || client.deleted_at) return null
  return {
    accountId: account.id,
    clientId: client.id,
    username: account.username,
    participantLabel: clientService.clientDisplayName(client)
  }
}

// Shift-note fields safe to expose in the portal: the shift metadata + the
// participant-facing narrative, including the incident narrative for a
// participant's own note (`incident_details`, decrypted here). Deliberately
// EXCLUDES billing fields (an operator concern) and never surfaces the
// structured NDIS incident register, which stays a staff surface. `body` and
// `incident_details` are rendered as Markdown by the client.
function toPortalNote (row) {
  return {
    id: row.id,
    shift_date: row.shift_date,
    start_time: row.start_time,
    end_time: row.end_time,
    duration_hours: row.duration_hours,
    location: row.location,
    support_provided: row.support_provided,
    participant_response: row.participant_response,
    incident_flag: !!row.incident_flag,
    incident_details: decrypt(row.incident_details),
    body: decrypt(row.body)
  }
}

/**
 * List the participant's finalised, non-deleted, non-archived shift notes,
 * newest first. Draft notes are never exposed — only finalised records the
 * worker has completed.
 * @param {number} clientId
 * @param {{perPage:number, offset:number}} pg
 * @returns {{rows:object[], total:number}}
 */
export function listNotes (clientId, pg) {
  const where = 'WHERE client_id = ? AND finalised = 1 AND deleted_at IS NULL AND archived_at IS NULL'
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM shift_notes ${where}`).get(clientId).c
  const rows = sqlite.prepare(`SELECT * FROM shift_notes ${where} ORDER BY shift_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(clientId, pg.perPage, pg.offset)
  return { rows: rows.map(toPortalNote), total }
}

/**
 * Fetch one of the participant's finalised notes (with photo metadata), or throw
 * 404. Scoped to the participant and to finalised/non-deleted notes so a portal
 * user can never fetch a draft or another participant's note by guessing an id.
 * @param {number} clientId
 * @param {number} noteId
 */
export function getNote (clientId, noteId) {
  const row = sqlite.prepare('SELECT * FROM shift_notes WHERE id = ? AND client_id = ? AND finalised = 1 AND deleted_at IS NULL AND archived_at IS NULL')
    .get(noteId, clientId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Shift note not found')
  const note = toPortalNote(row)
  note.photos = sqlite.prepare('SELECT id, original_name, mime_type, size_bytes, caption, created_at FROM shift_photos WHERE shift_note_id = ?').all(noteId)
  return note
}

/**
 * Resolve a photo attached to one of the participant's finalised notes (incl.
 * the on-disk filename), or throw 404. Enforces that the note belongs to the
 * participant and is finalised before the file is served.
 * @param {number} clientId
 * @param {number} noteId
 * @param {number} photoId
 */
export function getNotePhoto (clientId, noteId, photoId) {
  const note = sqlite.prepare('SELECT id FROM shift_notes WHERE id = ? AND client_id = ? AND finalised = 1 AND deleted_at IS NULL AND archived_at IS NULL')
    .get(noteId, clientId)
  if (!note) throw new ApiError(404, 'NOT_FOUND', 'Photo not found')
  const photo = sqlite.prepare('SELECT * FROM shift_photos WHERE id = ? AND shift_note_id = ?').get(photoId, noteId)
  if (!photo) throw new ApiError(404, 'NOT_FOUND', 'Photo not found')
  return photo
}

/**
 * List the participant's completed documents (non-deleted). Metadata only — the
 * file itself streams from the download route.
 * @param {number} clientId
 */
export function listDocuments (clientId) {
  return sqlite.prepare(`SELECT id, title, doc_type, issue_date, expiry_date, original_name, mime_type, size_bytes, created_at
      FROM client_documents WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .all(clientId)
}

/**
 * Fetch one of the participant's documents (incl. the on-disk filename), or
 * throw 404. Scoped to the participant so a portal user can only download their
 * own documents.
 * @param {number} clientId
 * @param {number} docId
 */
export function getDocument (clientId, docId) {
  const doc = sqlite.prepare('SELECT * FROM client_documents WHERE id = ? AND client_id = ? AND deleted_at IS NULL').get(docId, clientId)
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found')
  return doc
}
