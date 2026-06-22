import { Router } from 'express'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import { sqlite } from '../db/connection.js'
import { validate } from '../middleware/validate.js'
import {
  loginSchema, totpConfirmSchema, totpDisableSchema, changePasswordSchema,
  passkeyRegisterSchema, passkeyLoginSchema, passkeyRenameSchema, securityPolicySchema
} from '../utils/validators.js'
import { ApiError } from '../middleware/errorHandler.js'
import { requireAuth, requireAdmin, ensureCsrfToken } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { logActivity } from '../services/activityService.js'
import * as twoFactor from '../services/twoFactorService.js'
import * as passkeys from '../services/passkeyService.js'
import { changePassword, destroyOtherSessions } from '../services/accountService.js'
import { throttleKey, globalThrottleKey, checkLockout, recordFailure, clearAttempts } from '../services/loginThrottle.js'
import { getRequire2fa, setRequire2fa, mustEnrolSecondFactor } from '../services/securityPolicyService.js'
import { stampDevice, listUserSessions, revokeSession } from '../services/sessionService.js'
import { ok } from '../utils/pagination.js'
import config from '../config.js'

const router = Router()

// A precomputed bcrypt hash compared against when the username does not exist,
// so a missing user takes the same time as a wrong password — closing the login
// timing oracle that would otherwise reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('carelane-timing-equaliser', 12)

// The username-only throttle tolerates more failures than the per-IP one (it is
// shared across every source IP) so genuine operator typos never lock the
// account, while still catching large distributed credential-stuffing runs.
const GLOBAL_MAX_ATTEMPTS = config.loginMaxAttempts * 5

// Passkey login is usernameless, so a per-account global key isn't possible;
// instead a single shared counter caps total failed assertions across every
// source IP (defeating a distributed attacker rotating IPs). Generous threshold
// — a genuine operator only ever produces a handful of failures.
const PASSKEY_GLOBAL_KEY = globalThrottleKey('__passkey_login__')
const PASSKEY_GLOBAL_MAX = config.loginMaxAttempts * 10

// Cap how often the unauthenticated passkey-login *options* endpoint can be hit
// from one source, so it can't be hammered to churn the session store / issue
// unlimited challenges.
const passkeyOptionsLimiter = rateLimit({ name: 'passkey-options', max: 30, windowMs: 60 * 1000 })

/**
 * Regenerate the session, mark it authenticated and return the user envelope
 * (with a fresh CSRF token). Shared by the password and passkey login paths.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} user user row
 * @param {Function} next
 * @param {object} [details] extra audit detail (e.g. login method)
 */
function establishSession (req, res, user, next, details) {
  req.session.regenerate(err => {
    if (err) return next(err)
    req.session.userId = user.id
    req.session.role = user.role
    stampDevice(req)
    const csrf = ensureCsrfToken(req.session)
    // When the require-2FA policy is on and this account has no second factor
    // yet, the session is established but flagged so the UI forces enrolment.
    const mustEnrol = mustEnrolSecondFactor(user)
    logActivity('auth', user.id, user.id, 'login', details)
    res.json(ok({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      must_enrol_2fa: mustEnrol,
      csrf_token: csrf
    }))
  })
}

/** Relying-party context (id/name/origin) derived from the current request. */
function rpContext (req) {
  return passkeys.resolveRp({ originHeader: req.get('origin'), host: req.get('host'), protocol: req.protocol })
}

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with username, password and (when enabled) a 2FA code
 */
router.post('/login', validate(loginSchema), (req, res, next) => {
  const key = throttleKey(req.ip, req.body.username)
  const userKey = globalThrottleKey(req.body.username)
  const lock = checkLockout(key)
  const userLock = checkLockout(userKey)
  if (lock.locked || userLock.locked) {
    const retryAfter = Math.max(lock.retryAfter, userLock.retryAfter)
    return next(new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`))
  }

  const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username)
  // Always run a bcrypt compare (against a dummy hash when the user is absent)
  // so response time does not reveal whether the username exists.
  const passwordOk = bcrypt.compareSync(req.body.password, user ? user.password_hash : DUMMY_HASH)
  if (!user || !passwordOk) {
    recordFailure(key)
    recordFailure(userKey, GLOBAL_MAX_ATTEMPTS)
    logActivity('auth', user?.id ?? null, user?.id ?? null, 'login_failed', { reason: 'credentials' })
    return next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'))
  }

  // Second factor, when the account has it enabled.
  if (user.totp_enabled) {
    if (!req.body.token) {
      // Password was correct but a code is required — signal the client to ask.
      return res.json(ok({ totp_required: true }))
    }
    if (!twoFactor.verifyLogin(user, req.body.token)) {
      recordFailure(key)
      recordFailure(userKey, GLOBAL_MAX_ATTEMPTS)
      logActivity('auth', user.id, user.id, 'login_failed', { reason: '2fa' })
      return next(new ApiError(401, 'INVALID_2FA', 'Invalid or expired authentication code'))
    }
  }

  clearAttempts(key)
  clearAttempts(userKey)
  establishSession(req, res, user, next)
})

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: End the current session
 */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json(ok({ logged_out: true })))
})

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Current authenticated user (and CSRF token)
 */
router.get('/me', requireAuth, (req, res) => {
  const user = sqlite.prepare('SELECT id, username, display_name, role, totp_enabled FROM users WHERE id = ?').get(req.session.userId)
  res.json(ok({
    ...user,
    totp_enabled: !!user.totp_enabled,
    must_enrol_2fa: mustEnrolSecondFactor(user),
    csrf_token: ensureCsrfToken(req.session)
  }))
})

/**
 * @openapi
 * /auth/security-policy:
 *   get: { tags: [Auth], summary: Get the second-factor enforcement policy (admin only) }
 *   put: { tags: [Auth], summary: Set whether a second factor is required for everyone (admin only) }
 */
router.get('/security-policy', requireAuth, requireAdmin, (req, res) => {
  res.json(ok({ require_2fa: getRequire2fa() }))
})

router.put('/security-policy', requireAuth, requireAdmin, validate(securityPolicySchema), (req, res, next) => {
  try {
    const actingUser = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
    const result = setRequire2fa(req.body.require_2fa === 1, actingUser)
    logActivity('settings', null, req.session.userId, 'security_policy_updated', { require_2fa: result.require_2fa })
    res.json(ok(result))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/sessions:
 *   get: { tags: [Auth], summary: List the current user's active sessions / devices }
 */
router.get('/sessions', requireAuth, (req, res) => {
  res.json(ok({ sessions: listUserSessions(req.session.userId, req.sessionID) }))
})

/**
 * @openapi
 * /auth/sessions/revoke-others:
 *   post: { tags: [Auth], summary: Sign out every other session for this user }
 */
router.post('/sessions/revoke-others', requireAuth, (req, res) => {
  const removed = destroyOtherSessions(req.session.userId, req.sessionID)
  logActivity('auth', req.session.userId, req.session.userId, 'sessions_revoked', { count: removed })
  res.json(ok({ revoked: removed }))
})

/**
 * @openapi
 * /auth/sessions/{sid}:
 *   delete: { tags: [Auth], summary: Revoke one of the current user's sessions remotely }
 */
router.delete('/sessions/:sid', requireAuth, (req, res, next) => {
  try {
    const isCurrent = req.params.sid === req.sessionID
    revokeSession(req.session.userId, req.params.sid)
    logActivity('auth', req.session.userId, req.session.userId, 'session_revoked', { current: isCurrent })
    res.json(ok({ revoked: true, current: isCurrent }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/2fa/status:
 *   get: { tags: [Auth], summary: Two-factor enrolment status for the current user }
 */
router.get('/2fa/status', requireAuth, (req, res) => {
  const status = twoFactor.getStatus(req.session.userId)
  res.json(ok({ ...status, recovery_codes_remaining: twoFactor.recoveryCodesRemaining(req.session.userId) }))
})

/**
 * @openapi
 * /auth/2fa/setup:
 *   post: { tags: [Auth], summary: Begin TOTP enrolment (returns secret + QR data URL) }
 */
router.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const { secret, otpauth_uri, issuer, account } = twoFactor.beginSetup(req.session.userId)
    const qr = await QRCode.toDataURL(otpauth_uri, { margin: 1, width: 220 })
    res.json(ok({ secret, otpauth_uri, qr_data_url: qr, issuer, account }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/2fa/enable:
 *   post: { tags: [Auth], summary: Confirm TOTP enrolment with a code; returns one-time recovery codes }
 */
router.post('/2fa/enable', requireAuth, validate(totpConfirmSchema), (req, res, next) => {
  try {
    const { recovery_codes } = twoFactor.confirmSetup(req.session.userId, req.body.token)
    logActivity('auth', req.session.userId, req.session.userId, '2fa_enabled')
    res.json(ok({ enabled: true, recovery_codes }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/2fa/disable:
 *   post: { tags: [Auth], summary: Disable TOTP (requires password re-entry) }
 */
router.post('/2fa/disable', requireAuth, validate(totpDisableSchema), (req, res, next) => {
  const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) {
    return next(new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect'))
  }
  twoFactor.disable(req.session.userId)
  logActivity('auth', req.session.userId, req.session.userId, '2fa_disabled')
  res.json(ok({ enabled: false }))
})

/**
 * @openapi
 * /auth/change-password:
 *   post: { tags: [Auth], summary: Change the current user's password (requires the current password) }
 */
router.post('/change-password', requireAuth, validate(changePasswordSchema), (req, res, next) => {
  try {
    changePassword(req.session.userId, req.body.current_password, req.body.new_password)
    // Invalidate every other session for this user so a password change (often
    // prompted by suspected compromise) revokes any attacker session too. The
    // caller's own session is preserved so they stay logged in.
    destroyOtherSessions(req.session.userId, req.sessionID)
    logActivity('auth', req.session.userId, req.session.userId, 'password_changed')
    res.json(ok({ changed: true }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys:
 *   get: { tags: [Auth], summary: List the current user's registered passkeys }
 */
router.get('/passkeys', requireAuth, (req, res) => {
  res.json(ok({ passkeys: passkeys.listCredentials(req.session.userId) }))
})

/**
 * @openapi
 * /auth/passkeys/register/options:
 *   post: { tags: [Auth], summary: Begin passkey enrolment (returns WebAuthn creation options) }
 */
router.post('/passkeys/register/options', requireAuth, async (req, res, next) => {
  try {
    const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
    // Re-authenticate before issuing a new passwordless login factor: a hijacked
    // session must not be able to silently enrol an attacker's authenticator.
    // 403 (not 401) so the API client shows the error instead of logging out.
    if (!req.body?.password || !bcrypt.compareSync(req.body.password, user.password_hash)) {
      return next(new ApiError(403, 'REAUTH_REQUIRED', 'Enter your current password to add a passkey'))
    }
    const options = await passkeys.beginRegistration(req.session.userId, user, rpContext(req))
    // Registration and login ceremonies use distinct session keys so a
    // concurrent login-options call cannot clobber an in-flight registration.
    req.session.webauthnRegChallenge = options.challenge
    res.json(ok(options))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys/register/verify:
 *   post: { tags: [Auth], summary: Complete passkey enrolment with the authenticator response }
 */
router.post('/passkeys/register/verify', requireAuth, validate(passkeyRegisterSchema), async (req, res, next) => {
  try {
    const expectedChallenge = req.session.webauthnRegChallenge
    if (!expectedChallenge) throw new ApiError(400, 'NO_CHALLENGE', 'No passkey registration in progress')
    const rp = rpContext(req)
    const result = await passkeys.finishRegistration(req.session.userId, {
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      name: req.body.name
    })
    req.session.webauthnRegChallenge = null
    logActivity('auth', req.session.userId, req.session.userId, 'passkey_registered')
    res.json(ok(result))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys/{id}:
 *   put: { tags: [Auth], summary: Rename a registered passkey }
 */
router.put('/passkeys/:id', requireAuth, validate(passkeyRenameSchema), (req, res, next) => {
  try {
    passkeys.renameCredential(req.session.userId, Number(req.params.id), req.body.name)
    res.json(ok({ renamed: true }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys/{id}:
 *   delete: { tags: [Auth], summary: Remove a registered passkey }
 */
router.delete('/passkeys/:id', requireAuth, (req, res, next) => {
  try {
    // Removing a login factor is security-sensitive: require password re-entry so
    // a hijacked session can't strip the legitimate user's passkeys. Mirrors the
    // re-auth already enforced on passkey registration and 2FA disable. 403 (not
    // 401) so the client surfaces the error instead of logging the user out.
    const user = sqlite.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.userId)
    if (!req.body?.password || !user || !bcrypt.compareSync(req.body.password, user.password_hash)) {
      return next(new ApiError(403, 'REAUTH_REQUIRED', 'Enter your current password to remove a passkey'))
    }
    passkeys.deleteCredential(req.session.userId, Number(req.params.id))
    logActivity('auth', req.session.userId, req.session.userId, 'passkey_removed')
    res.json(ok({ removed: true }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys/login/options:
 *   post: { tags: [Auth], summary: Begin a passwordless passkey login (returns WebAuthn request options) }
 */
router.post('/passkeys/login/options', passkeyOptionsLimiter, async (req, res, next) => {
  try {
    const options = await passkeys.beginLogin(rpContext(req))
    req.session.webauthnLoginChallenge = options.challenge
    res.json(ok(options))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /auth/passkeys/login/verify:
 *   post: { tags: [Auth], summary: Complete a passwordless passkey login and start a session }
 */
router.post('/passkeys/login/verify', validate(passkeyLoginSchema), async (req, res, next) => {
  // Rate-limit the unauthenticated passkey assertion path: per-IP (mirroring the
  // password login throttle) plus a shared global counter so a distributed
  // attacker rotating source IPs still hits a ceiling on the credential lookup.
  const key = throttleKey(req.ip, 'passkey')
  if (checkLockout(key).locked || checkLockout(PASSKEY_GLOBAL_KEY).locked) {
    return next(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many passkey attempts. Try again later.'))
  }
  try {
    const expectedChallenge = req.session.webauthnLoginChallenge
    if (!expectedChallenge) throw new ApiError(400, 'NO_CHALLENGE', 'No passkey login in progress')
    const rp = rpContext(req)
    const user = await passkeys.finishLogin({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID
    })
    req.session.webauthnLoginChallenge = null
    clearAttempts(key)
    clearAttempts(PASSKEY_GLOBAL_KEY)
    establishSession(req, res, user, next, { method: 'passkey' })
  } catch (err) {
    recordFailure(key)
    recordFailure(PASSKEY_GLOBAL_KEY, PASSKEY_GLOBAL_MAX)
    next(err)
  }
})

export default router
