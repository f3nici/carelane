import { Router } from 'express'
import fs from 'node:fs'
import { validate, validatePartial } from '../middleware/validate.js'
import { reportSchema, reportDraftSchema } from '../utils/validators.js'
import * as reportService from '../services/reportService.js'
import * as shiftService from '../services/shiftService.js'
import * as clientService from '../services/clientService.js'
import { resolveTemplateForDraft } from '../services/templateService.js'
import { condenseShift, draftReport } from '../services/aiService.js'
import { renderPdf, pdfPath, safeFilename } from '../utils/pdfRenderer.js'
import { logActivity } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import { sqlite } from '../db/connection.js'

const router = Router()

/**
 * @openapi
 * /reports:
 *   get: { tags: [Reports], summary: List reports }
 *   post: { tags: [Reports], summary: Create a report }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = reportService.listReports(pg, req.query)
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
  logActivity('report', report.id, req.session.userId, action)
  res.json(ok(report))
})

router.delete('/:id', (req, res) => {
  reportService.deleteReport(Number(req.params.id))
  logActivity('report', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /reports/{id}/draft:
 *   post:
 *     tags: [Reports]
 *     summary: AI-draft the report (condense shifts with Haiku, draft with Sonnet; draft only)
 */
router.post('/:id/draft', validate(reportDraftSchema), async (req, res, next) => {
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

    // token optimisation: condense each note (Haiku) before the single Sonnet draft
    const summaries = []
    for (const id of shiftIds.slice(0, 60)) {
      const shift = shiftService.getShift(id)
      const note = shift.body || shift.support_provided
      if (!note) continue
      summaries.push(await condenseShift({ date: shift.shift_date, note }, req.session.userId))
    }
    if (!summaries.length) throw new ApiError(409, 'NO_CONTENT', 'Selected shifts have no notes to summarise')

    const template = resolveTemplateForDraft('report', { templateId: req.body.template_id, reportType: report.report_type })
    const body = await draftReport({
      clientLabel: label,
      reportType: report.report_type,
      periodStart: report.period_start || '',
      periodEnd: report.period_end || '',
      goals: client.support_goals,
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
 * /reports/{id}/pdf:
 *   get: { tags: [Reports], summary: Render/download the report PDF (auth-gated) }
 */
router.get('/:id/pdf', async (req, res, next) => {
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
