import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'
import { destroyOtherSessions } from './accountService.js'

/**
 * User (login) management for multi-user CareLane. Admin-only: lists, creates
 * and updates support-worker logins, resets their passwords and deactivates
 * them. Passwords are bcrypt-hashed (cost 12) to match the seed and core
 * accountService — never reversibly encrypted.
 *
 * Users are never hard-deleted: their id is referenced by the regulated records
 * they authored (shift notes, incidents, …), so a departing worker is
 * deactivated (`active = 0`) instead, which blocks login while keeping history
 * intact.
 */

const BCRYPT_COST = 12
const now = () => new Date().toISOString()

/** Public shape of a user row (never exposes the password hash or 2FA secret). */
const PUBLIC_COLS = 'id, username, display_name, role, active, totp_enabled, created_at, updated_at'

/**
 * How many active admins exist (excluding an optionally-ignored id). Used to
 * refuse any change that would remove the last admin and lock everyone out.
 * @param {number} [exceptId]
 * @returns {number}
 */
function activeAdminCount (exceptId = null) {
  return sqlite.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
    .get(exceptId ?? -1).c
}

/** Fetch one user (public columns) with their assigned-participant count, or 404. */
export function getUser (id) {
  const user = sqlite.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id)
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  const assigned = sqlite.prepare('SELECT COUNT(*) AS c FROM client_assignments WHERE user_id = ?').get(id).c
  return { ...user, active: !!user.active, totp_enabled: !!user.totp_enabled, assigned_client_count: assigned }
}

/** List all users with their assigned-participant counts. */
export function listUsers () {
  const rows = sqlite.prepare(`SELECT ${PUBLIC_COLS},
      (SELECT COUNT(*) FROM client_assignments a WHERE a.user_id = users.id) AS assigned_client_count
    FROM users ORDER BY role, display_name, username`).all()
  return rows.map(u => ({ ...u, active: !!u.active, totp_enabled: !!u.totp_enabled }))
}

/**
 * Create a worker (or admin) login.
 * @param {{username:string, display_name:string, password:string, role:string}} data
 * @returns {object} the new user (public shape)
 */
export function createUser (data) {
  const existing = sqlite.prepare('SELECT id FROM users WHERE username = ?').get(data.username)
  if (existing) throw new ApiError(409, 'USERNAME_TAKEN', 'That username is already in use')
  const ts = now()
  const hash = bcrypt.hashSync(data.password, BCRYPT_COST)
  const id = sqlite.prepare(`INSERT INTO users (username, password_hash, display_name, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(data.username, hash, data.display_name, data.role, ts, ts).lastInsertRowid
  return getUser(id)
}

/**
 * Update a user's display name, role and/or active flag. Refuses any change that
 * would leave no active admin.
 * @param {number} id
 * @param {{display_name?:string, role?:string, active?:number}} data
 * @returns {object} updated user (public shape)
 */
export function updateUser (id, data) {
  const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id)
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  const willBeAdmin = 'role' in data ? data.role === 'admin' : user.role === 'admin'
  const willBeActive = 'active' in data ? data.active === 1 : user.active === 1
  // If this user is currently the account's safety net (an active admin) and the
  // change would strip that, block it unless another active admin remains.
  const wasActiveAdmin = user.role === 'admin' && user.active === 1
  if (wasActiveAdmin && !(willBeAdmin && willBeActive) && activeAdminCount(id) === 0) {
    throw new ApiError(409, 'LAST_ADMIN', 'At least one active admin must remain')
  }

  const sets = []
  const params = []
  for (const col of ['display_name', 'role', 'active']) {
    if (!(col in data)) continue
    sets.push(`${col} = ?`)
    params.push(data[col])
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  // A deactivated login must not keep working via a live cookie — revoke every
  // session it holds.
  if ('active' in data && data.active === 0) destroyOtherSessions(id, '')
  return getUser(id)
}

/**
 * Admin reset of another user's password (no current-password check — this is an
 * operator recovering a worker's access). Revokes the target's existing sessions
 * so a lost/compromised device can't keep the old session alive.
 * @param {number} id
 * @param {string} newPassword
 */
export function resetPassword (id, newPassword) {
  const user = sqlite.prepare('SELECT id FROM users WHERE id = ?').get(id)
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  sqlite.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, BCRYPT_COST), now(), id)
  destroyOtherSessions(id, '')
}
