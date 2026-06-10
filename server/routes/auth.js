import { Router } from 'express'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import { sqlite } from '../db/connection.js'
import { validate } from '../middleware/validate.js'
import { loginSchema, totpConfirmSchema, totpDisableSchema } from '../utils/validators.js'
import { ApiError } from '../middleware/errorHandler.js'
import { requireAuth, ensureCsrfToken } from '../middleware/auth.js'
import { logActivity } from '../services/activityService.js'
import * as twoFactor from '../services/twoFactorService.js'
import { throttleKey, checkLockout, recordFailure, clearAttempts } from '../services/loginThrottle.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with username, password and (when enabled) a 2FA code
 */
router.post('/login', validate(loginSchema), (req, res, next) => {
  const key = throttleKey(req.ip, req.body.username)
  const lock = checkLockout(key)
  if (lock.locked) {
    return next(new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} minute(s).`))
  }

  const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username)
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) {
    recordFailure(key)
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
      logActivity('auth', user.id, user.id, 'login_failed', { reason: '2fa' })
      return next(new ApiError(401, 'INVALID_2FA', 'Invalid or expired authentication code'))
    }
  }

  clearAttempts(key)
  req.session.regenerate(err => {
    if (err) return next(err)
    req.session.userId = user.id
    req.session.role = user.role
    const csrf = ensureCsrfToken(req.session)
    logActivity('auth', user.id, user.id, 'login')
    res.json(ok({ id: user.id, username: user.username, display_name: user.display_name, role: user.role, csrf_token: csrf }))
  })
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
  res.json(ok({ ...user, totp_enabled: !!user.totp_enabled, csrf_token: ensureCsrfToken(req.session) }))
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

export default router
