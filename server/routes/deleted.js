import { Router } from 'express'
import { listDeleted, restoreDeleted } from '../services/deletedService.js'
import { logActivity } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /deleted:
 *   get:
 *     tags: [Deleted]
 *     summary: List soft-deleted records (clients, agreements, shifts, reports, templates) and deactivated billing codes
 */
router.get('/', (req, res) => {
  res.json(ok(listDeleted()))
})

/**
 * @openapi
 * /deleted/{type}/{id}/restore:
 *   post:
 *     tags: [Deleted]
 *     summary: Restore a soft-deleted record (or reactivate a deactivated billing code)
 */
router.post('/:type/:id/restore', (req, res) => {
  const { type } = req.params
  const id = Number(req.params.id)
  const { entity_type, action, details, data } = restoreDeleted(type, id)
  logActivity(entity_type, id, req.session.userId, action, details)
  res.json(ok(data))
})

export default router
