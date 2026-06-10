import { Router } from 'express'
import { validate, validatePartial } from '../middleware/validate.js'
import { clientSchema, clientBillingCodesSchema } from '../utils/validators.js'
import * as clientService from '../services/clientService.js'
import * as agreementService from '../services/agreementService.js'
import * as shiftService from '../services/shiftService.js'
import { logActivity } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /clients:
 *   get:
 *     tags: [Clients]
 *     summary: List clients (search on minimal non-encrypted fields)
 *   post:
 *     tags: [Clients]
 *     summary: Create a client (PII encrypted at rest)
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = clientService.listClients(pg, req.query)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(clientSchema), (req, res) => {
  const client = clientService.createClient(req.body)
  logActivity('client', client.id, req.session.userId, 'created')
  res.status(201).json(ok(client))
})

/**
 * @openapi
 * /clients/{id}:
 *   get: { tags: [Clients], summary: Get a client }
 *   put: { tags: [Clients], summary: Update a client }
 *   delete: { tags: [Clients], summary: Soft-delete a client (retention) }
 */
router.get('/:id', (req, res) => {
  res.json(ok(clientService.getClient(Number(req.params.id))))
})

router.put('/:id', validatePartial(clientSchema), (req, res) => {
  const client = clientService.updateClient(Number(req.params.id), req.body)
  logActivity('client', client.id, req.session.userId, 'updated', { fields: Object.keys(req.body).length })
  res.json(ok(client))
})

router.delete('/:id', (req, res) => {
  clientService.deleteClient(Number(req.params.id))
  logActivity('client', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/** Privacy: full data export for a client (data access request). */
router.get('/:id/export', (req, res) => {
  const data = clientService.exportClient(Number(req.params.id))
  logActivity('client', Number(req.params.id), req.session.userId, 'exported')
  res.json(ok(data))
})

router.get('/:id/agreements', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = agreementService.listAgreements(pg, { client_id: req.params.id })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.get('/:id/shifts', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = shiftService.listShifts(pg, { ...req.query, client_id: req.params.id })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.get('/:id/billing-codes', (req, res) => {
  res.json(ok(clientService.getClientBillingCodes(Number(req.params.id))))
})

router.put('/:id/billing-codes', validate(clientBillingCodesSchema), (req, res) => {
  const codes = clientService.setClientBillingCodes(Number(req.params.id), req.body.codes)
  logActivity('client', Number(req.params.id), req.session.userId, 'updated', { billing_codes: codes.length })
  res.json(ok(codes))
})

export default router
