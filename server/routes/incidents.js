import { Router } from 'express'
import { validate, validatePartial } from '../middleware/validate.js'
import { incidentReportSchema } from '../utils/validators.js'
import * as incidentService from '../services/incidentService.js'
import { assertClientAccess } from '../middleware/auth.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { renderPdf, pdfPath, safeFilename } from '../utils/pdfRenderer.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'

const router = Router()

// Workers may view incident reports for their assigned participants; creating,
// promoting from a shift, editing and deleting are admin-only.
router.param('id', (req, res, next, value) => {
  try {
    assertClientAccess(req, incidentService.getIncident(Number(value)).client_id)
    next()
  } catch (err) { next(err) }
})
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.isAdmin) return next()
  next(new ApiError(403, 'FORBIDDEN', 'Read-only access — ask an admin to make changes'))
})

/**
 * @openapi
 * /incidents:
 *   get: { tags: [Incidents], summary: List structured incident reports }
 *   post: { tags: [Incidents], summary: Create an incident report }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = incidentService.listIncidents(pg, { ...req.query, client_ids: req.assignedClientIds })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(incidentReportSchema), (req, res) => {
  const incident = incidentService.createIncident(req.body, req.session.userId)
  logActivity('incident', incident.id, req.session.userId, 'created', { client_id: incident.client_id, reportable: !!incident.reportable })
  res.status(201).json(ok(incident))
})

/**
 * @openapi
 * /incidents/from-shift/{shiftId}:
 *   post: { tags: [Incidents], summary: Promote an incident-flagged shift note into a structured incident report }
 */
router.post('/from-shift/:shiftId', (req, res) => {
  const incident = incidentService.createFromShift(Number(req.params.shiftId), req.session.userId)
  logActivity('incident', incident.id, req.session.userId, 'created', { from_shift: Number(req.params.shiftId), client_id: incident.client_id })
  res.status(201).json(ok(incident))
})

/**
 * @openapi
 * /incidents/{id}:
 *   get: { tags: [Incidents], summary: Get one incident report }
 *   put: { tags: [Incidents], summary: Update an incident report }
 *   delete: { tags: [Incidents], summary: Soft-delete an incident report (record retention) }
 */
router.get('/:id', (req, res) => {
  res.json(ok(incidentService.getIncident(Number(req.params.id))))
})

router.put('/:id', validatePartial(incidentReportSchema), (req, res) => {
  const before = incidentService.getIncident(Number(req.params.id))
  const incident = incidentService.updateIncident(Number(req.params.id), req.body)
  let action = 'updated'
  if (before.status !== 'closed' && incident.status === 'closed') action = 'closed'
  else if (!before.reported_to_ndis && incident.reported_to_ndis) action = 'reported'
  logActivity('incident', incident.id, req.session.userId, action, { changes: diffChanges(before, incident, Object.keys(req.body)) })
  res.json(ok(incident))
})

router.delete('/:id', (req, res) => {
  incidentService.deleteIncident(Number(req.params.id))
  logActivity('incident', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /incidents/{id}/export.pdf:
 *   get: { tags: [Incidents], summary: Download the incident report as a branded PDF (auth-gated) }
 */
router.get('/:id/export.pdf', async (req, res, next) => {
  try {
    const incident = incidentService.getIncident(Number(req.params.id))
    const filename = await renderPdf({
      title: `Incident report${incident.reference_no ? ` — ${incident.reference_no}` : ''}`,
      subtitle: `${incident.client_display_name} · ${incident.incident_date}`,
      body: incidentService.buildIncidentMarkdown(incident),
      footer: 'Confidential — contains sensitive health information. Handle per NDIS incident-management and privacy obligations.'
    })
    logActivity('incident', incident.id, req.session.userId, 'exported', { format: 'pdf' })
    res.download(pdfPath(filename), safeFilename(`incident-${incident.id}-${incident.incident_date}`), err => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) { next(err) }
})

export default router
