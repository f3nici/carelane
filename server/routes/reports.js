import { Router } from 'express'
import fs from 'node:fs'
import { validate, validatePartial } from '../middleware/validate.js'
import { reportSchema, reportDraftSchema } from '../utils/validators.js'
import * as reportService from '../services/reportService.js'
import * as shiftService from '../services/shiftService.js'
import * as clientService from '../services/clientService.js'
import { assertClientAccess, demoLock } from '../middleware/auth.js'
import { buildGoalsSummary } from '../services/goalService.js'
import { resolveTemplateForDraft } from '../services/templateService.js'
import { condenseShift, draftReport, estimateReportTokens } from '../services/aiService.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { mapLimit } from '../utils/async.js'
import { renderPdf, pdfPath, safeFilename } from '../utils/pdfRenderer.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import { sqlite } from '../db/connection.js'

const router = Router()
// Report drafting fans out to many Haiku + one Sonnet call; cap per-operator.
const aiLimiter = rateLimit({ name: 'ai-report', max: 10, windowMs: 60 * 1000 })

// Workers may read reports for their assigned participants; creating, editing,
// drafting and finalising are admin-only.
router.param('id', (req, res, next, value) => {
  try {
    assertClientAccess(req, reportService.getReport(Number(value)).client_id)
    next()
  } catch (err) { next(err) }
})
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.isAdmin) return next()
  next(new ApiError(403, 'FORBIDDEN', "You don't have access to this"))
})

/**
 * @openapi
 * /reports:
 *   get: { tags: [Reports], summary: List reports }
 *   post: { tags: [Reports], summary: Create a report }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = reportService.listReports(pg, { ...req.query, client_ids: req.assignedClientIds })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(reportSchema), (req, res) => {
  const report = reportService.createReport(req.body)
  logActivity('report', report.id, req.session.userId, 'created')
  res.status(201).json(ok(report))
})

router.get('/:id', (req, res) => {
  res.json(ok(reportService.getReport(Number(req.params.id))))
})

router.put('/:id', validatePartial(reportSchema), (req, res) => {
  const before = reportService.getReport(Number(req.params.id))
  const report = reportService.updateReport(Number(req.params.id), req.body)
  const action = before.status === 'draft' && report.status === 'final' ? 'finalised' : 'updated'
  logActivity('report', report.id, req.session.userId, action, { changes: diffChanges(before, report, Object.keys(req.body)) })
  res.json(ok(report))
})

router.delete('/:id', (req, res) => {
  reportService.deleteReport(Number(req.params.id))
  logActivity('report', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /reports/{id}/archive:
 *   post: { tags: [Reports], summary: Archive a report (hidden from active lists, not deleted) }
 */
router.post('/:id/archive', (req, res) => {
  const report = reportService.archiveReport(Number(req.params.id))
  logActivity('report', report.id, req.session.userId, 'archived')
  res.json(ok(report))
})

/**
 * @openapi
 * /reports/{id}/unarchive:
 *   post: { tags: [Reports], summary: Unarchive a report (return it to active lists) }
 */
router.post('/:id/unarchive', (req, res) => {
  const report = reportService.unarchiveReport(Number(req.params.id))
  logActivity('report', report.id, req.session.userId, 'unarchived')
  res.json(ok(report))
})

/**
 * @openapi
 * /reports/{id}/draft:
 *   post:
 *     tags: [Reports]
 *     summary: AI-draft the report (condense shifts with Haiku, draft with Sonnet; draft only)
 */
router.post('/:id/draft', aiLimiter, validate(reportDraftSchema), async (req, res, next) => {
  try {
    const report = reportService.getReport(Number(req.params.id))
    if (report.status === 'final') throw new ApiError(409, 'FINALISED', 'Final reports cannot be redrafted')
    const client = clientService.getClient(report.client_id)
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()

    let shiftIds = req.body.shift_ids
    if (!shiftIds?.length) {
      shiftIds = sqlite.prepare(`SELECT id FROM shift_notes WHERE client_id = ? AND deleted_at IS NULL
        AND shift_date >= COALESCE(?, '0000') AND shift_date <= COALESCE(?, '9999') ORDER BY shift_date`)
        .all(report.client_id, report.period_start, report.period_end).map(r => r.id)
    }
    if (!shiftIds.length) throw new ApiError(409, 'NO_SHIFTS', 'No shift notes found in the report period')

    // token optimisation: condense each note (Haiku) before the single Sonnet
    // draft. Gather the notes first (sync decrypt), then condense with bounded
    // concurrency so a long report period isn't dozens of serial round-trips.
    const notes = []
    for (const id of shiftIds.slice(0, 60)) {
      const shift = shiftService.getShift(id)
      const note = shift.body || shift.support_provided
      if (note) notes.push({ date: shift.shift_date, note })
    }
    if (!notes.length) throw new ApiError(409, 'NO_CONTENT', 'Selected shifts have no notes to summarise')
    const summaries = await mapLimit(notes, 5, n => condenseShift(n, req.session.userId))

    const template = resolveTemplateForDraft('report', { templateId: req.body.template_id, reportType: report.report_type })
    const body = await draftReport({
      clientLabel: label,
      reportType: report.report_type,
      periodStart: report.period_start || '',
      periodEnd: report.period_end || '',
      // Prefer structured goals + progress notes; fall back to the free-text field.
      goals: buildGoalsSummary(report.client_id) || client.support_goals,
      shiftSummaries: summaries,
      template
    }, req.session.userId)

    const updated = reportService.updateReport(report.id, { body_markdown: body, source_shift_ids: shiftIds, status: 'draft' })
    logActivity('report', report.id, req.session.userId, 'ai_drafted', { shifts: shiftIds.length, template_id: template?.id ?? null })
    res.json(ok(updated))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /reports/{id}/draft/estimate:
 *   post: { tags: [Reports], summary: Estimate the draft's input tokens (no AI call) }
 */
router.post('/:id/draft/estimate', (req, res, next) => {
  try {
    const report = reportService.getReport(Number(req.params.id))
    const client = clientService.getClient(report.client_id)
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    const periodStart = req.body.period_start ?? report.period_start ?? ''
    const periodEnd = req.body.period_end ?? report.period_end ?? ''
    let shiftIds = req.body.shift_ids
    if (!shiftIds?.length) {
      shiftIds = sqlite.prepare(`SELECT id FROM shift_notes WHERE client_id = ? AND deleted_at IS NULL
        AND shift_date >= COALESCE(?, '0000') AND shift_date <= COALESCE(?, '9999') ORDER BY shift_date`)
        .all(report.client_id, periodStart || null, periodEnd || null).map(r => r.id)
    }
    // Proxy each condensed summary with the first ~200 chars of the note — the
    // real summaries (1-2 lines) only exist after the Haiku pass, so we estimate.
    const shiftSummaries = shiftIds.slice(0, 60).map(id => {
      const shift = shiftService.getShift(id)
      const note = shift.body || shift.support_provided
      return note ? `${shift.shift_date}: ${note.slice(0, 200)}` : null
    }).filter(Boolean)
    const template = resolveTemplateForDraft('report', { templateId: req.body.template_id, reportType: report.report_type })
    const estimated_tokens = estimateReportTokens({
      clientLabel: label,
      reportType: report.report_type,
      periodStart,
      periodEnd,
      goals: buildGoalsSummary(report.client_id) || client.support_goals,
      shiftSummaries,
      template
    })
    res.json(ok({ estimated_tokens }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /reports/{id}/pdf:
 *   get: { tags: [Reports], summary: Render/download the report PDF (auth-gated) }
 */
router.get('/:id/pdf', demoLock, async (req, res, next) => {
  try {
    const report = reportService.getReport(Number(req.params.id))
    if (!report.body_markdown) throw new ApiError(409, 'NO_BODY', 'Report has no body to render')
    // Always re-render so edits and branding changes (e.g. a new logo) are
    // reflected; the previous file is removed to avoid orphaned PDFs.
    const previous = report.pdf_filename
    const docTitle = `${report.report_type.replace('_', ' ')} report`
    const filename = await renderPdf({
      title: docTitle,
      subtitle: `Period ${report.period_start || ''} to ${report.period_end || ''}`,
      body: report.body_markdown
    })
    reportService.setReportPdf(report.id, filename)
    if (previous && previous !== filename) { try { fs.rmSync(pdfPath(previous)) } catch { /* already gone */ } }
    res.download(pdfPath(filename), safeFilename(docTitle, `report-${report.id}`))
  } catch (err) { next(err) }
})

export default router
