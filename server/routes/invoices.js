import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { squareSettingsSchema } from '../utils/validators.js'
import * as square from '../services/squareService.js'
import { updateSettings } from '../services/settingsService.js'
import { logActivity } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /invoices/square/status:
 *   get: { tags: [Invoices], summary: Square invoicing connection status }
 */
router.get('/square/status', (req, res) => {
  res.json(ok(square.status()))
})

/** Live health check: confirm the Square token reaches the account + location. */
router.post('/square/test', async (req, res) => {
  const result = await square.testConnection()
  logActivity('square', null, req.session.userId, 'tested', { ok: result.ok })
  res.json(ok(result))
})

/** Dismiss the live error banner (audit-log history is untouched). */
router.post('/square/clear-error', (req, res) => {
  res.json(ok(square.clearError()))
})

/** Update operator-facing Square settings (enable, location, currency). */
router.put('/square/settings', validate(squareSettingsSchema), (req, res) => {
  const patch = {}
  if ('enabled' in req.body) patch.square_invoicing_enabled = req.body.enabled
  if ('location_id' in req.body) patch.square_location_id = req.body.location_id
  if ('currency' in req.body) patch.square_currency = req.body.currency
  updateSettings(patch)
  logActivity('square', null, req.session.userId, 'updated', { keys: Object.keys(patch) })
  res.json(ok(square.status()))
})

/**
 * @openapi
 * /invoices:
 *   get: { tags: [Invoices], summary: List Square invoices CareLane has created (filter by client_id / shift_note_id) }
 */
router.get('/', (req, res) => {
  res.json(ok(square.listInvoices(req.query)))
})

/**
 * @openapi
 * /invoices/from-shift/{shiftId}:
 *   post: { tags: [Invoices], summary: Create a draft Square invoice from a shift note }
 */
router.post('/from-shift/:shiftId', async (req, res) => {
  const result = await square.createDraftInvoiceFromShift(Number(req.params.shiftId), req.session.userId)
  res.status(201).json(ok(result))
})

export default router
