import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { activityQuerySchema } from '../utils/validators.js'
import { queryActivity, activityFacets } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /audit:
 *   get:
 *     tags: [Audit]
 *     summary: Filterable, paginated view of the append-only (PII-redacted) audit log
 */
router.get('/', validate(activityQuerySchema, 'query'), (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = queryActivity(req.validatedQuery, pg)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

/**
 * @openapi
 * /audit/facets:
 *   get: { tags: [Audit], summary: Distinct entity types and actions for filter dropdowns }
 */
router.get('/facets', (req, res) => {
  res.json(ok(activityFacets()))
})

export default router
