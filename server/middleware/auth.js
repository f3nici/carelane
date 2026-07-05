import crypto from 'node:crypto'
import { ApiError } from './errorHandler.js'
import { sqlite } from '../db/connection.js'
import { listAssignedClientIds, canAccessClient } from '../services/accessService.js'

/**
 * Require an authenticated session. All `/api/v1` routes except auth/login
 * sit behind this.
 */
export function requireAuth (req, res, next) {
  if (req.session?.userId) return next()
  next(new ApiError(401, 'UNAUTHENTICATED', 'You are not authenticated. Please log in.'))
}

/**
 * Load the current user fresh and attach the access context used across the API:
 * `req.currentUser`, `req.isAdmin` and (for workers) `req.assignedClientIds`
 * (the participant ids they may see; admins get `null` = unrestricted).
 *
 * Reading the row live — rather than trusting the role stamped on the session at
 * login — means an admin deactivating a login or changing its role takes effect
 * on the worker's very next request, not only after they log in again. A
 * deactivated account is rejected immediately.
 *
 * Runs after {@link requireAuth}, so a session is guaranteed present.
 */
export function attachAccess (req, res, next) {
  const user = sqlite.prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?')
    .get(req.session.userId)
  if (!user || !user.active) {
    return req.session.destroy(() => next(new ApiError(401, 'UNAUTHENTICATED', 'You are not authenticated. Please log in.')))
  }
  req.currentUser = user
  req.isAdmin = user.role === 'admin'
  req.assignedClientIds = req.isAdmin ? null : listAssignedClientIds(user.id)
  next()
}

/**
 * Require the admin role (settings, user management, all write paths that a
 * support worker may not perform).
 */
export function requireAdmin (req, res, next) {
  if (req.isAdmin ?? req.session?.role === 'admin') return next()
  next(new ApiError(403, 'FORBIDDEN', "You don't have access to this"))
}

/**
 * Throw unless the current user may access the given participant. Admins pass;
 * workers must have the participant assigned.
 * @param {import('express').Request} req
 * @param {number} clientId
 */
export function assertClientAccess (req, clientId) {
  if (!canAccessClient(req.currentUser, clientId)) {
    throw new ApiError(403, 'FORBIDDEN', "You don't have access to this")
  }
}

/**
 * Express `router.param` handler enforcing participant access for any route
 * whose `:id` (or a named param) is a participant id. Register with
 * `router.param('id', requireClientParam)`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 * @param {string} value the matched id
 */
export function requireClientParam (req, res, next, value) {
  try {
    assertClientAccess(req, Number(value))
    next()
  } catch (err) { next(err) }
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
