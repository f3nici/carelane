import crypto from 'node:crypto'
import { ApiError } from './errorHandler.js'

/**
 * Require an authenticated session. All `/api/v1` routes except auth/login
 * sit behind this.
 */
export function requireAuth (req, res, next) {
  if (req.session?.userId) return next()
  next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication required'))
}

/**
 * Require the admin role (settings, user management).
 */
export function requireAdmin (req, res, next) {
  if (req.session?.userId && req.session.role === 'admin') return next()
  next(new ApiError(403, 'FORBIDDEN', 'Admin access required'))
}

/**
 * Double-submit CSRF guard for state-changing requests. The token is issued
 * with the session (GET /auth/me, login response) and must be echoed back in
 * the `x-csrf-token` header.
 */
export function csrfProtect (req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path === '/auth/login') return next()
  // Passkey login happens before any session/CSRF token exists; the WebAuthn
  // challenge bound to the session is itself the anti-forgery guard here.
  if (req.path.startsWith('/auth/passkeys/login/')) return next()
  const token = req.get('x-csrf-token')
  if (req.session?.csrfToken && token && timingSafeStrEqual(token, req.session.csrfToken)) return next()
  next(new ApiError(403, 'CSRF_ERROR', 'Missing or invalid CSRF token'))
}

/**
 * Constant-time string comparison. A plain `===` short-circuits on the first
 * differing byte, leaking how much of a secret (here the CSRF token) was
 * guessed correctly via response timing; this does not.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeStrEqual (a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Generate and store a CSRF token on the session if absent. */
export function ensureCsrfToken (session) {
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(24).toString('hex')
  return session.csrfToken
}
