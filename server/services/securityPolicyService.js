import { sqlite } from '../db/connection.js'
import { getSetting, updateSettings } from './settingsService.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Operator security policy: an optional requirement that every login is
 * protected by a second factor (TOTP) or a passkey. Single-operator by default,
 * so enforcement is lockout-safe by design — turning the policy on never blocks
 * a password login outright. Instead, an account that lacks a second factor is
 * allowed in but flagged `must_enrol_2fa`, and the UI funnels it to Settings to
 * enrol before doing anything else. A passkey counts as a second factor (it is a
 * possession factor with mandatory user verification), so a passkey user is not
 * forced to also set up TOTP.
 */

const POLICY_KEY = 'require_2fa'

/** @returns {boolean} whether a second factor is currently required by policy. */
export function getRequire2fa () {
  return !!getSetting(POLICY_KEY, 0)
}

/**
 * Number of passkeys registered to a user.
 * @param {number} userId
 * @returns {number}
 */
export function passkeyCount (userId) {
  return sqlite.prepare('SELECT COUNT(*) AS c FROM webauthn_credentials WHERE user_id = ?').get(userId).c
}

/**
 * Whether a user already has any second factor (TOTP enabled or a passkey).
 * @param {object} user user row
 * @returns {boolean}
 */
export function userHasSecondFactor (user) {
  if (!user) return false
  if (user.totp_enabled) return true
  return passkeyCount(user.id) > 0
}

/**
 * Whether the policy is on and this user has not yet satisfied it. Drives the
 * `must_enrol_2fa` flag returned at login and on `/auth/me`.
 * @param {object} user user row
 * @returns {boolean}
 */
export function mustEnrolSecondFactor (user) {
  return getRequire2fa() && !userHasSecondFactor(user)
}

/**
 * Update the require-second-factor policy. Enabling it is guarded: the acting
 * admin must already have a second factor of their own, so the policy can never
 * be switched on by an account that would immediately be locked into enrolment
 * with no way to demonstrate intent.
 * @param {boolean} enabled
 * @param {object} actingUser the admin making the change (user row)
 * @returns {{ require_2fa: boolean }}
 */
export function setRequire2fa (enabled, actingUser) {
  if (enabled && !userHasSecondFactor(actingUser)) {
    throw new ApiError(400, 'POLICY_BLOCKED',
      'Set up your own two-factor authentication or a passkey before requiring it for everyone.')
  }
  updateSettings({ [POLICY_KEY]: enabled ? 1 : 0 })
  return { require_2fa: !!enabled }
}
