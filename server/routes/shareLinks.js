import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { shareLinkSchema } from '../utils/validators.js'
import { demoLock } from '../middleware/auth.js'
import * as shareLinkService from '../services/shareLinkService.js'
import { ok } from '../utils/pagination.js'

/**
 * Operator management of client-facing share links. Admin-only (mounted with
 * `requireAdmin` in app.js) — a share link exposes participant data outside the
 * app, so a support worker never creates one. The public side (fetching a shared
 * item without an account) lives in routes/sharePublic.js.
 */
const router = Router()

/**
 * @openapi
 * /share-links:
 *   get: { tags: [ShareLinks], summary: List share links (optionally filtered by resource or participant) }
 *   post: { tags: [ShareLinks], summary: Create a time-limited read-only share link for a finalised report or completed document }
 */
router.get('/', (req, res) => {
  const links = shareLinkService.listShareLinks({
    resource_type: req.query.resource_type,
    resource_id: req.query.resource_id,
    client_id: req.query.client_id
  }, req)
  res.json(ok(links))
})

router.post('/', demoLock, validate(shareLinkSchema), (req, res) => {
  const link = shareLinkService.createShareLink(req.body, req.session.userId, req)
  res.status(201).json(ok(link))
})

/**
 * @openapi
 * /share-links/{id}/revoke:
 *   post: { tags: [ShareLinks], summary: Revoke a share link (existing URLs stop working immediately) }
 */
router.post('/:id/revoke', (req, res) => {
  const link = shareLinkService.revokeShareLink(Number(req.params.id), req.session.userId, req)
  res.json(ok(link))
})

export default router
