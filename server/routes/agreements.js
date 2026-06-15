import { Router } from 'express'
import fs from 'node:fs'
import { validate, validatePartial } from '../middleware/validate.js'
import { agreementSchema, agreementDraftSchema } from '../utils/validators.js'
import * as agreementService from '../services/agreementService.js'
import * as clientService from '../services/clientService.js'
import { resolveTemplateForDraft } from '../services/templateService.js'
import { draftAgreement, estimateAgreementTokens } from '../services/aiService.js'
import { renderPdf, pdfPath, safeFilename } from '../utils/pdfRenderer.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /agreements:
 *   get: { tags: [Agreements], summary: List service agreements }
 *   post: { tags: [Agreements], summary: Create a service agreement }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = agreementService.listAgreements(pg, req.query)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(agreementSchema), (req, res) => {
  const agreement = agreementService.createAgreement(req.body)
  logActivity('agreement', agreement.id, req.session.userId, 'created')
  res.status(201).json(ok(agreement))
})

router.get('/:id', (req, res) => {
  res.json(ok(agreementService.getAgreement(Number(req.params.id))))
})

router.put('/:id', validatePartial(agreementSchema), (req, res) => {
  const before = agreementService.getAgreement(Number(req.params.id))
  const agreement = agreementService.updateAgreement(Number(req.params.id), req.body)
  logActivity('agreement', agreement.id, req.session.userId, 'updated', { changes: diffChanges(before, agreement, Object.keys(req.body)) })
  res.json(ok(agreement))
})

router.delete('/:id', (req, res) => {
  agreementService.deleteAgreement(Number(req.params.id))
  logActivity('agreement', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /agreements/{id}/archive:
 *   post: { tags: [Agreements], summary: Archive an agreement (hidden from active lists, not deleted) }
 */
router.post('/:id/archive', (req, res) => {
  const agreement = agreementService.archiveAgreement(Number(req.params.id))
  logActivity('agreement', agreement.id, req.session.userId, 'archived')
  res.json(ok(agreement))
})

/**
 * @openapi
 * /agreements/{id}/unarchive:
 *   post: { tags: [Agreements], summary: Unarchive an agreement (return it to active lists) }
 */
router.post('/:id/unarchive', (req, res) => {
  const agreement = agreementService.unarchiveAgreement(Number(req.params.id))
  logActivity('agreement', agreement.id, req.session.userId, 'unarchived')
  res.json(ok(agreement))
})

/**
 * @openapi
 * /agreements/{id}/draft:
 *   post:
 *     tags: [Agreements]
 *     summary: AI-draft the agreement body from the stored questionnaire (draft only — worker must review)
 */
router.post('/:id/draft', validate(agreementDraftSchema), async (req, res, next) => {
  try {
    const agreement = agreementService.getAgreement(Number(req.params.id))
    if (!agreement.questionnaire_json) throw new ApiError(409, 'NO_QUESTIONNAIRE', 'Complete the questionnaire before drafting')
    const client = clientService.getClient(agreement.client_id)
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    const template = resolveTemplateForDraft('agreement', { templateId: req.body.template_id })
    const body = await draftAgreement({ clientLabel: label, questionnaire: JSON.parse(agreement.questionnaire_json), template }, req.session.userId)
    const updated = agreementService.updateAgreement(agreement.id, { body_markdown: body, status: 'draft' })
    logActivity('agreement', agreement.id, req.session.userId, 'ai_drafted', { template_id: template?.id ?? null })
    res.json(ok(updated))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /agreements/{id}/draft/estimate:
 *   post: { tags: [Agreements], summary: Estimate the draft's input tokens (no AI call) }
 */
router.post('/:id/draft/estimate', async (req, res, next) => {
  try {
    const agreement = agreementService.getAgreement(Number(req.params.id))
    const client = clientService.getClient(agreement.client_id)
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    // Prefer the live (possibly unsaved) questionnaire from the editor; fall
    // back to the stored one.
    const questionnaire = req.body.questionnaire ?? (agreement.questionnaire_json ? JSON.parse(agreement.questionnaire_json) : {})
    const template = resolveTemplateForDraft('agreement', { templateId: req.body.template_id })
    const estimated_tokens = await estimateAgreementTokens({ clientLabel: label, questionnaire, template })
    res.json(ok({ estimated_tokens }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /agreements/{id}/sign:
 *   post: { tags: [Agreements], summary: Record participant signature (human action) }
 */
router.post('/:id/sign', (req, res) => {
  const agreement = agreementService.signAgreement(Number(req.params.id), req.body?.signed_date)
  logActivity('agreement', agreement.id, req.session.userId, 'finalised', { signed: true })
  res.json(ok(agreement))
})

/**
 * @openapi
 * /agreements/{id}/pdf:
 *   get: { tags: [Agreements], summary: Render/download the agreement PDF (auth-gated) }
 */
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const agreement = agreementService.getAgreement(Number(req.params.id))
    if (!agreement.body_markdown) throw new ApiError(409, 'NO_BODY', 'Agreement has no body to render')
    // Always re-render so edits and branding changes (e.g. a new logo) are
    // reflected; the previous file is removed to avoid orphaned PDFs.
    const previous = agreement.pdf_filename
    const filename = await renderPdf({
      title: agreement.title,
      subtitle: `Service agreement · ${agreement.start_date || ''} to ${agreement.end_date || ''}${agreement.signed_by_client ? ` · signed ${agreement.signed_date}` : ''}`,
      body: agreement.body_markdown
    })
    agreementService.setAgreementPdf(agreement.id, filename)
    if (previous && previous !== filename) { try { fs.rmSync(pdfPath(previous)) } catch { /* already gone */ } }
    res.download(pdfPath(filename), safeFilename(agreement.title, `agreement-${agreement.id}`))
  } catch (err) { next(err) }
})

export default router
