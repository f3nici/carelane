import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { ZipArchive } from 'archiver'
import { validate, validatePartial } from '../middleware/validate.js'
import { clientSchema, clientBillingCodesSchema, clientDocumentMetaSchema, goalSchema, goalProgressSchema } from '../utils/validators.js'
import * as clientService from '../services/clientService.js'
import * as agreementService from '../services/agreementService.js'
import * as shiftService from '../services/shiftService.js'
import * as clientDocumentService from '../services/clientDocumentService.js'
import * as goalService from '../services/goalService.js'
import { CLIENT_DOC_DIR } from '../services/clientDocumentService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { renderPdf, pdfPath } from '../utils/pdfRenderer.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

const ALLOWED_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(CLIENT_DOC_DIR, { recursive: true })
      cb(null, CLIENT_DOC_DIR)
    },
    // non-guessable filename: completed documents hold PII and are served only behind auth
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: config.uploadLimitFor(25 * 1024 * 1024) },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_DOC_TYPES.includes(file.mimetype))
})

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
  const before = clientService.getClient(Number(req.params.id))
  const client = clientService.updateClient(Number(req.params.id), req.body)
  logActivity('client', client.id, req.session.userId, 'updated', { changes: diffChanges(before, client, Object.keys(req.body)) })
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

/**
 * @openapi
 * /clients/{id}/export.zip:
 *   get:
 *     tags: [Clients]
 *     summary: One-click "download everything" for a participant — a zip of the
 *       full JSON export plus a branded PDF summary (data access request)
 */
router.get('/:id/export.zip', async (req, res, next) => {
  const id = Number(req.params.id)
  try {
    const data = clientService.exportClient(id)
    const pdfFilename = await renderPdf({
      title: `Participant data export — ${clientService.clientDisplayName(data.client)}`,
      subtitle: `Generated ${data.exported_at.slice(0, 10)}`,
      body: clientService.buildClientExportMarkdown(data),
      footer: 'Confidential — contains sensitive health information. Handle per NDIS privacy obligations.'
    })
    logActivity('client', id, req.session.userId, 'exported', { format: 'zip' })

    res.attachment(`participant-${id}-export.zip`)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    archive.on('error', err => next(err))
    archive.pipe(res)
    archive.append(JSON.stringify(data, null, 2), { name: `participant-${id}.json` })
    archive.file(pdfPath(pdfFilename), { name: `participant-${id}.pdf` })
    await archive.finalize()
  } catch (err) {
    next(err)
  }
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

/**
 * @openapi
 * /clients/{id}/documents:
 *   get: { tags: [Clients], summary: List a client's completed documents }
 *   post: { tags: [Clients], summary: Upload a completed document (signed agreement / finalised report; served auth-gated) }
 */
router.get('/:id/documents', (req, res) => {
  res.json(ok(clientDocumentService.listClientDocuments(Number(req.params.id))))
})

router.post('/:id/documents', docUpload.single('file'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'Upload a PDF or image file'))
  const doc = clientDocumentService.createClientDocument(Number(req.params.id), req.file, req.body)
  logActivity('client', Number(req.params.id), req.session.userId, 'updated', { document_added: doc.doc_type })
  res.status(201).json(ok(doc))
})

/**
 * @openapi
 * /clients/{id}/documents/{docId}:
 *   put: { tags: [Clients], summary: Update a document's metadata (type, issue/expiry dates) without re-uploading }
 *   delete: { tags: [Clients], summary: Archive (soft-delete) a completed document }
 */
router.put('/:id/documents/:docId', validatePartial(clientDocumentMetaSchema), (req, res) => {
  const doc = clientDocumentService.updateClientDocument(Number(req.params.id), Number(req.params.docId), req.body)
  logActivity('client', Number(req.params.id), req.session.userId, 'updated', { document_updated: doc.doc_type })
  res.json(ok(doc))
})

/** Auth-gated file serving — completed documents are never exposed as a public static path. */
router.get('/:id/documents/:docId/file', (req, res, next) => {
  const doc = clientDocumentService.getClientDocument(Number(req.params.id), Number(req.params.docId))
  // Forward filesystem errors (e.g. a row whose file is missing after a partial
  // restore) to the handler instead of leaking a stack/path or hanging.
  res.download(path.resolve(CLIENT_DOC_DIR, path.basename(doc.filename)), doc.original_name || doc.filename, err => {
    if (err && !res.headersSent) next(new ApiError(404, 'FILE_NOT_FOUND', 'Document file is unavailable'))
  })
})

router.delete('/:id/documents/:docId', (req, res) => {
  clientDocumentService.deleteClientDocument(Number(req.params.id), Number(req.params.docId))
  logActivity('client', Number(req.params.id), req.session.userId, 'updated', { document_archived: true })
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /clients/{id}/goals:
 *   get: { tags: [Clients], summary: List a participant's structured goals (with progress summary) }
 *   post: { tags: [Clients], summary: Create a structured goal }
 */
router.get('/:id/goals', (req, res) => {
  res.json(ok(goalService.listGoals(Number(req.params.id), req.query)))
})

router.post('/:id/goals', validate(goalSchema), (req, res) => {
  const goal = goalService.createGoal(Number(req.params.id), req.body)
  logActivity('goal', goal.id, req.session.userId, 'created', { client_id: Number(req.params.id) })
  res.status(201).json(ok(goal))
})

/**
 * @openapi
 * /clients/{id}/goals/{goalId}:
 *   get: { tags: [Clients], summary: Get one goal with its progress notes }
 *   put: { tags: [Clients], summary: Update a goal (e.g. mark achieved) }
 *   delete: { tags: [Clients], summary: Soft-delete a goal (record retention) }
 */
router.get('/:id/goals/:goalId', (req, res) => {
  res.json(ok(goalService.getGoal(Number(req.params.id), Number(req.params.goalId))))
})

router.put('/:id/goals/:goalId', validatePartial(goalSchema), (req, res) => {
  const before = goalService.getGoal(Number(req.params.id), Number(req.params.goalId))
  const goal = goalService.updateGoal(Number(req.params.id), Number(req.params.goalId), req.body)
  const action = before.status !== 'achieved' && goal.status === 'achieved' ? 'achieved' : 'updated'
  logActivity('goal', goal.id, req.session.userId, action, { changes: diffChanges(before, goal, Object.keys(req.body)) })
  res.json(ok(goal))
})

router.delete('/:id/goals/:goalId', (req, res) => {
  goalService.deleteGoal(Number(req.params.id), Number(req.params.goalId))
  logActivity('goal', Number(req.params.goalId), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /clients/{id}/goals/{goalId}/progress:
 *   post: { tags: [Clients], summary: Add a dated progress note to a goal (body encrypted at rest) }
 */
router.post('/:id/goals/:goalId/progress', validate(goalProgressSchema), (req, res) => {
  const goal = goalService.addProgressNote(Number(req.params.id), Number(req.params.goalId), req.body)
  logActivity('goal', goal.id, req.session.userId, 'progress_logged', { note_date: req.body.note_date || null })
  res.status(201).json(ok(goal))
})

router.delete('/:id/goals/:goalId/progress/:noteId', (req, res) => {
  const goal = goalService.deleteProgressNote(Number(req.params.id), Number(req.params.goalId), Number(req.params.noteId))
  logActivity('goal', goal.id, req.session.userId, 'updated', { progress_removed: true })
  res.json(ok(goal))
})

export default router
