import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { userCreateSchema, userUpdateSchema, userPasswordResetSchema, assignmentsSchema } from '../utils/validators.js'
import { requireAdmin } from '../middleware/auth.js'
import * as userService from '../services/userService.js'
import * as accessService from '../services/accessService.js'
import { logActivity } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'

const router = Router()
const id = req => Number(req.params.id)

// Every user-management endpoint is admin-only.
router.use(requireAdmin)

/**
 * @openapi
 * /users:
 *   get: { tags: [Users], summary: List all logins (admin) }
 *   post: { tags: [Users], summary: Create a support-worker (or admin) login }
 */
router.get('/', (req, res) => {
  res.json(ok(userService.listUsers()))
})

router.post('/', validate(userCreateSchema), (req, res) => {
  const user = userService.createUser(req.body)
  logActivity('user', user.id, req.session.userId, 'created', { role: user.role })
  res.status(201).json(ok(user))
})

/**
 * @openapi
 * /users/{id}:
 *   get: { tags: [Users], summary: Get one login }
 *   put: { tags: [Users], summary: Update a login (display name, role, active) }
 */
router.get('/:id', (req, res) => {
  res.json(ok(userService.getUser(id(req))))
})

router.put('/:id', validate(userUpdateSchema), (req, res) => {
  const user = userService.updateUser(id(req), req.body)
  logActivity('user', user.id, req.session.userId, 'updated', {
    role: 'role' in req.body ? user.role : undefined,
    active: 'active' in req.body ? !!user.active : undefined
  })
  res.json(ok(user))
})

/**
 * @openapi
 * /users/{id}/reset-password:
 *   post: { tags: [Users], summary: Admin-reset a login's password (revokes its sessions) }
 */
router.post('/:id/reset-password', validate(userPasswordResetSchema), (req, res) => {
  userService.resetPassword(id(req), req.body.new_password)
  logActivity('user', id(req), req.session.userId, 'password_reset')
  res.json(ok({ reset: true }))
})

/**
 * @openapi
 * /users/{id}/clients:
 *   get: { tags: [Users], summary: List the participant ids assigned to a worker }
 *   put: { tags: [Users], summary: Replace the participants assigned to a worker }
 */
router.get('/:id/clients', (req, res) => {
  userService.getUser(id(req)) // 404 if the user does not exist
  res.json(ok({ client_ids: accessService.listAssignedClientIds(id(req)) }))
})

router.put('/:id/clients', validate(assignmentsSchema), (req, res) => {
  userService.getUser(id(req))
  const clientIds = accessService.setWorkerClients(id(req), req.body.client_ids, req.session.userId)
  logActivity('user', id(req), req.session.userId, 'assignments_updated', { count: clientIds.length })
  res.json(ok({ client_ids: clientIds }))
})

export default router
