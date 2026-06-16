import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Account credential management (password changes). Kept in the service layer
 * so routes never deal with hashing directly. Passwords are bcrypt-hashed
 * (cost 12, matching the seed) — they are never reversibly encrypted.
 */

const BCRYPT_COST = 12
const now = () => new Date().toISOString()

/** Fetch a user row by id or throw 404. */
function getUser (userId) {
  const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  return user
}

/**
 * Change a user's password after verifying their current one. Rejects a no-op
 * (new === current) so the change is meaningful.
 * @param {number} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 */
export function changePassword (userId, currentPassword, newPassword) {
  const user = getUser(userId)
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect')
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    throw new ApiError(400, 'PASSWORD_UNCHANGED', 'New password must be different from the current one')
  }
  sqlite.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, BCRYPT_COST), now(), userId)
}

/**
 * Destroy all persisted sessions belonging to a user except the one to keep.
 * Used after a password change so other (possibly attacker) sessions are
 * revoked. Operates directly on the better-sqlite3-session-store `sessions`
 * table; `userId` is stored inside the JSON `sess` blob.
 * @param {number} userId
 * @param {string} [keepSid] session id to preserve (the current request's)
 * @returns {number} number of sessions removed
 */
export function destroyOtherSessions (userId, keepSid = '') {
  const res = sqlite.prepare(
    "DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid != ?"
  ).run(userId, keepSid)
  return res.changes
}

/**
 * Force-set a user's password by username (offline CLI recovery only — there is
 * no current-password check). Returns the affected user id.
 * @param {string} username
 * @param {string} newPassword
 * @returns {number} user id
 */
export function setPasswordByUsername (username, newPassword) {
  const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) throw new ApiError(404, 'NOT_FOUND', `No user named "${username}"`)
  sqlite.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, BCRYPT_COST), now(), user.id)
  return user.id
}
