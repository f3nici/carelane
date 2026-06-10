import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import { validate } from '../middleware/validate.js'
import { loginSchema } from '../utils/validators.js'
import { ApiError } from '../middleware/errorHandler.js'
import { requireAuth, ensureCsrfToken } from '../middleware/auth.js'
import { logActivity } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with username and password
 */
router.post('/login', validate(loginSchema), (req, res, next) => {
  const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username)
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) {
    return next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'))
  }
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
  const user = sqlite.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId)
  res.json(ok({ ...user, csrf_token: ensureCsrfToken(req.session) }))
})

export default router
