import { Router } from 'express'
import { validate, validatePartial } from '../middleware/validate.js'
import { templateSchema } from '../utils/validators.js'
import * as templateService from '../services/templateService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /templates:
 *   get: { tags: [Templates], summary: List drafting templates (agreements & reports) }
 *   post: { tags: [Templates], summary: Create a reusable drafting template }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = templateService.listTemplates(pg, req.query)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(templateSchema), (req, res) => {
  const template = templateService.createTemplate(req.body)
  logActivity('template', template.id, req.session.userId, 'created')
  res.status(201).json(ok(template))
})

router.get('/:id', (req, res) => {
  res.json(ok(templateService.getTemplate(Number(req.params.id))))
})

router.put('/:id', validatePartial(templateSchema), (req, res) => {
  const before = templateService.getTemplate(Number(req.params.id))
  const template = templateService.updateTemplate(Number(req.params.id), req.body)
  logActivity('template', template.id, req.session.userId, 'updated', { changes: diffChanges(before, template, Object.keys(req.body)) })
  res.json(ok(template))
})

router.delete('/:id', (req, res) => {
  templateService.deleteTemplate(Number(req.params.id))
  logActivity('template', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

export default router
