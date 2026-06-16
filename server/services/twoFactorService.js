import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import { encrypt, decrypt } from './cryptoService.js'
import { generateSecret, otpauthUri, verifyToken, verifyTokenCounter } from './totpService.js'
import { getSetting } from './settingsService.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Two-factor (TOTP) enrolment and verification for user accounts. The secret
 * and the bcrypt-hashed recovery codes are encrypted at rest here — the routes
 * never touch raw secrets, matching the "encryption only in services" rule.
 */

const RECOVERY_CODE_COUNT = 10
// Recovery codes are high-entropy (80-bit) random values, so a bcrypt work
// factor of 10 is ample — and hashing/comparing ten of them synchronously at a
// higher cost would block the event loop for seconds. Security comes from the
// code entropy here, not the hash cost.
const RECOVERY_CODE_COST = 10
const now = () => new Date().toISOString()

/** Fetch a user row by id or throw 404. */
function getUser (userId) {
  const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  return user
}

/**
 * Whether two-factor auth is currently enabled for a user.
 * @param {number} userId
 * @returns {{ enabled: boolean, pending: boolean }} pending = secret stored but not yet confirmed
 */
export function getStatus (userId) {
  const user = getUser(userId)
  return { enabled: !!user.totp_enabled, pending: !user.totp_enabled && !!user.totp_secret }
}

/**
 * Begin enrolment: generate a fresh secret (not yet active) and return the
 * provisioning URI for the authenticator app. Overwrites any prior pending
 * secret so a restarted setup is clean.
 * @param {number} userId
 * @returns {{ secret: string, otpauth_uri: string, issuer: string, account: string }}
 */
export function beginSetup (userId) {
  const user = getUser(userId)
  if (user.totp_enabled) throw new ApiError(409, 'TOTP_ALREADY_ENABLED', 'Two-factor authentication is already enabled')
  const secret = generateSecret()
  const issuer = getSetting('business_name', 'CareLane') || 'CareLane'
  const account = user.username
  sqlite.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_recovery_codes = NULL, updated_at = ? WHERE id = ?')
    .run(encrypt(secret), now(), userId)
  return { secret, otpauth_uri: otpauthUri(secret, account, issuer), issuer, account }
}

/**
 * Confirm enrolment by verifying a token against the pending secret. On success
 * 2FA is enabled and a one-time set of recovery codes is generated and returned
 * (shown to the user once — only their hashes are persisted).
 * @param {number} userId
 * @param {string} token
 * @returns {{ recovery_codes: string[] }}
 */
export function confirmSetup (userId, token) {
  const user = getUser(userId)
  if (user.totp_enabled) throw new ApiError(409, 'TOTP_ALREADY_ENABLED', 'Two-factor authentication is already enabled')
  if (!user.totp_secret) throw new ApiError(400, 'TOTP_NOT_STARTED', 'Start two-factor setup first')
  const secret = decrypt(user.totp_secret)
  if (!verifyToken(secret, token)) throw new ApiError(400, 'INVALID_TOTP', 'That code is incorrect or expired — try again')
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode)
  const hashes = codes.map(c => bcrypt.hashSync(normalise(c), RECOVERY_CODE_COST))
  sqlite.prepare('UPDATE users SET totp_enabled = 1, totp_recovery_codes = ?, updated_at = ? WHERE id = ?')
    .run(encrypt(JSON.stringify(hashes)), now(), userId)
  return { recovery_codes: codes }
}

/**
 * Disable two-factor auth, clearing the secret and recovery codes.
 * @param {number} userId
 */
export function disable (userId) {
  getUser(userId)
  sqlite.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL, updated_at = ? WHERE id = ?')
    .run(now(), userId)
}

/**
 * Verify a login second factor: accepts either a current TOTP code or one of
 * the user's unused recovery codes (which is then consumed).
 * @param {object} user user row (with encrypted totp columns)
 * @param {string} token submitted code
 * @returns {boolean}
 */
export function verifyLogin (user, token) {
  if (!user?.totp_enabled || !token) return false
  const secret = decrypt(user.totp_secret)
  const matched = verifyTokenCounter(secret, token)
  if (matched !== null) {
    // Replay defence: reject a code at a time-step we've already accepted, then
    // record this step as the new high-water mark.
    if (user.totp_last_counter != null && matched <= user.totp_last_counter) return false
    sqlite.prepare('UPDATE users SET totp_last_counter = ?, updated_at = ? WHERE id = ?')
      .run(matched, now(), user.id)
    return true
  }
  return consumeRecoveryCode(user, token)
}

/**
 * Number of unused recovery codes remaining for a user.
 * @param {number} userId
 * @returns {number}
 */
export function recoveryCodesRemaining (userId) {
  const user = getUser(userId)
  if (!user.totp_recovery_codes) return 0
  try { return JSON.parse(decrypt(user.totp_recovery_codes)).length } catch { return 0 }
}

/** Match a submitted code against the stored hashes; consume it on a hit. */
function consumeRecoveryCode (user, token) {
  if (!user.totp_recovery_codes) return false
  let hashes
  try { hashes = JSON.parse(decrypt(user.totp_recovery_codes)) } catch { return false }
  const candidate = normalise(token)
  const idx = hashes.findIndex(h => bcrypt.compareSync(candidate, h))
  if (idx === -1) return false
  hashes.splice(idx, 1)
  sqlite.prepare('UPDATE users SET totp_recovery_codes = ?, updated_at = ? WHERE id = ?')
    .run(encrypt(JSON.stringify(hashes)), now(), user.id)
  return true
}

/** A readable 80-bit recovery code like `a1b2-c3d4-e5f6-7a8b-9c0d`. */
function generateRecoveryCode () {
  const hex = crypto.randomBytes(10).toString('hex')
  return hex.match(/.{4}/g).join('-')
}

/** Normalise a code for comparison (lower-case, strip spaces/dashes). */
function normalise (code) {
  return String(code).toLowerCase().replace(/[\s-]/g, '')
}
