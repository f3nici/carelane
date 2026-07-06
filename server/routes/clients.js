import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { ZipArchive } from 'archiver'
import { validate, validatePartial } from '../middleware/validate.js'
import { clientSchema, clientBillingCodesSchema, clientDocumentMetaSchema, goalSchema, goalProgressSchema, restrictivePracticeSchema, medicationRecordSchema, clientWorkersSchema } from '../utils/validators.js'
import { requireClientParam, requireAdmin, demoLock } from '../middleware/auth.js'
import * as accessService from '../services/accessService.js'
import * as clientService from '../services/clientService.js'
import * as agreementService from '../services/agreementService.js'
import * as shiftService from '../services/shiftService.js'
import * as clientDocumentService from '../services/clientDocumentService.js'
import * as goalService from '../services/goalService.js'
import * as restrictivePracticeService from '../services/restrictivePracticeService.js'
import * as medicationService from '../services/medicationService.js'
import { CLIENT_DOC_DIR } from '../services/clientDocumentService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { renderPdf, pdfPath } from '../utils/pdfRenderer.js'
import { sniffFileType, sanitizeDownloadName } from '../utils/fileType.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

// Access control for the participant module:
//  - a worker may only reach participants assigned to them (enforced on every
//    `:id` route by the param guard);
//  - the whole participant record is read-only for workers — creating,
//    editing, deleting or uploading is admin-only.
router.param('id', requireClientParam)
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.isAdmin) return next()
  next(new ApiError(403, 'FORBIDDEN', "You don't have access to this"))
})

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
  // A worker only ever lists their assigned participants; an admin sees all
  // (req.assignedClientIds is null → unrestricted).
  const { rows, total } = clientService.listClients(pg, { ...req.query, client_ids: req.assignedClientIds })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(clientSchema), (req, res) => {
  const client = clientService.createClient(req.body)
  logActivity('client', client.id, req.session.userId, 'created')
  res.status(201).json(ok(client))
})

/**
 * @openapi
 * /clients/{id}/workers:
 *   get: { tags: [Clients], summary: List the support workers assigned to a participant (admin) }
 *   put: { tags: [Clients], summary: Replace the support workers assigned to a participant (admin) }
 */
router.get('/:id/workers', (req, res) => {
  res.json(ok(accessService.listClientWorkers(Number(req.params.id))))
})

router.put('/:id/workers', validate(clientWorkersSchema), (req, res) => {
  const workers = accessService.setClientWorkers(Number(req.params.id), req.body.user_ids, req.session.userId)
  logActivity('client', Number(req.params.id), req.session.userId, 'workers_updated', { count: workers.length })
  res.json(ok(workers))
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

/** Privacy: full data export for a client (data access request; admin only). */
router.get('/:id/export', requireAdmin, demoLock, (req, res) => {
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
router.get('/:id/export.zip', requireAdmin, demoLock, async (req, res, next) => {
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

router.get('/:id/agreements', requireAdmin, (req, res) => {
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
  const codes = clientService.getClientBillingCodes(Number(req.params.id))
  // The per-participant charge rate is operator-commercial info — strip it (and
  // the standard price caps) for support workers, who only need to pick a code.
  const visible = req.isAdmin
    ? codes
    : codes.map(c => {
      const copy = { ...c }
      for (const k of ['custom_rate', 'price_cap_standard', 'price_cap_remote', 'price_cap_very_remote']) delete copy[k]
      return copy
    })
  res.json(ok(visible))
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

router.post('/:id/documents', demoLock, docUpload.single('file'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'Upload a PDF or image file'))
  // The multer fileFilter only sees the client-declared Content-Type, which is
  // forgeable. Verify the saved file's real type from its magic bytes and reject
  // (deleting the upload) on a mismatch; store the detected type, not the claim.
  const detected = sniffFileType(req.file.path)
  if (!detected || !ALLOWED_DOC_TYPES.includes(detected)) {
    fs.rm(req.file.path, () => {})
    return next(new ApiError(400, 'UPLOAD_ERROR', 'File contents are not a supported PDF or image'))
  }
  req.file.mimetype = detected
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
  res.download(path.resolve(CLIENT_DOC_DIR, path.basename(doc.filename)), sanitizeDownloadName(doc.original_name, doc.filename), err => {
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

/**
 * @openapi
 * /clients/{id}/restrictive-practices:
 *   get: { tags: [Clients], summary: List a participant's restrictive-practice records }
 *   post: { tags: [Clients], summary: Log a restrictive-practice use (narrative encrypted at rest) }
 */
router.get('/:id/restrictive-practices', (req, res) => {
  res.json(ok(restrictivePracticeService.listRestrictivePractices(Number(req.params.id), req.query)))
})

router.post('/:id/restrictive-practices', validate(restrictivePracticeSchema), (req, res) => {
  const record = restrictivePracticeService.createRestrictivePractice(Number(req.params.id), req.body, req.session.userId)
  logActivity('restrictive_practice', record.id, req.session.userId, 'created', { client_id: Number(req.params.id), authorised: !!record.authorised })
  res.status(201).json(ok(record))
})

/**
 * @openapi
 * /clients/{id}/restrictive-practices/{recordId}:
 *   put: { tags: [Clients], summary: Update a restrictive-practice record }
 *   delete: { tags: [Clients], summary: Soft-delete a restrictive-practice record (record retention) }
 */
router.put('/:id/restrictive-practices/:recordId', validatePartial(restrictivePracticeSchema), (req, res) => {
  const before = restrictivePracticeService.getRestrictivePractice(Number(req.params.id), Number(req.params.recordId))
  const record = restrictivePracticeService.updateRestrictivePractice(Number(req.params.id), Number(req.params.recordId), req.body)
  logActivity('restrictive_practice', record.id, req.session.userId, 'updated', { changes: diffChanges(before, record, Object.keys(req.body)) })
  res.json(ok(record))
})

router.delete('/:id/restrictive-practices/:recordId', (req, res) => {
  restrictivePracticeService.deleteRestrictivePractice(Number(req.params.id), Number(req.params.recordId))
  logActivity('restrictive_practice', Number(req.params.recordId), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /clients/{id}/medications:
 *   get: { tags: [Clients], summary: List a participant's medication administration records }
 *   post: { tags: [Clients], summary: Log a medication administration (reason/notes encrypted at rest) }
 */
router.get('/:id/medications', (req, res) => {
  res.json(ok(medicationService.listMedicationRecords(Number(req.params.id), req.query)))
})

router.post('/:id/medications', validate(medicationRecordSchema), (req, res) => {
  const record = medicationService.createMedicationRecord(Number(req.params.id), req.body, req.session.userId)
  logActivity('medication', record.id, req.session.userId, 'created', { client_id: Number(req.params.id), status: record.status })
  res.status(201).json(ok(record))
})

/**
 * @openapi
 * /clients/{id}/medications/{recordId}:
 *   put: { tags: [Clients], summary: Update a medication record }
 *   delete: { tags: [Clients], summary: Soft-delete a medication record (record retention) }
 */
router.put('/:id/medications/:recordId', validatePartial(medicationRecordSchema), (req, res) => {
  const before = medicationService.getMedicationRecord(Number(req.params.id), Number(req.params.recordId))
  const record = medicationService.updateMedicationRecord(Number(req.params.id), Number(req.params.recordId), req.body)
  logActivity('medication', record.id, req.session.userId, 'updated', { changes: diffChanges(before, record, Object.keys(req.body)) })
  res.json(ok(record))
})

router.delete('/:id/medications/:recordId', (req, res) => {
  medicationService.deleteMedicationRecord(Number(req.params.id), Number(req.params.recordId))
  logActivity('medication', Number(req.params.recordId), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

export default router
