import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { validate, validatePartial } from '../middleware/validate.js'
import { shiftSchema, shiftDraftSchema } from '../utils/validators.js'
import * as shiftService from '../services/shiftService.js'
import * as clientService from '../services/clientService.js'
import { draftShiftNote, estimateTokens } from '../services/aiService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

const PHOTO_DIR = path.join(config.uploadPath, 'photos')
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(PHOTO_DIR, { recursive: true })
      cb(null, PHOTO_DIR)
    },
    // non-guessable filename: photos may contain PII and are served only behind auth
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: config.maxUploadSize },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
  }
})

/**
 * @openapi
 * /shifts:
 *   get: { tags: [Shifts], summary: List shift notes }
 *   post: { tags: [Shifts], summary: Create a shift note }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = shiftService.listShifts(pg, req.query)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(shiftSchema), (req, res) => {
  const shift = shiftService.createShift(req.body, req.session.userId)
  logActivity('shift', shift.id, req.session.userId, 'created', { incident: !!shift.incident_flag })
  res.status(201).json(ok(shift))
})

router.get('/:id', (req, res) => {
  res.json(ok(shiftService.getShift(Number(req.params.id))))
})

router.put('/:id', validatePartial(shiftSchema), (req, res) => {
  const before = shiftService.getShift(Number(req.params.id))
  const shift = shiftService.updateShift(Number(req.params.id), req.body)
  let action = 'updated'
  if (!before.finalised && shift.finalised) action = 'finalised'
  else if (before.finalised && !shift.finalised) action = 'reopened'
  logActivity('shift', shift.id, req.session.userId, action, {
    incident: !!shift.incident_flag,
    changes: diffChanges(before, shift, Object.keys(req.body))
  })
  res.json(ok(shift))
})

router.delete('/:id', (req, res) => {
  shiftService.deleteShift(Number(req.params.id))
  logActivity('shift', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /shifts/{id}/archive:
 *   post: { tags: [Shifts], summary: Archive a shift note (hidden from active lists, not deleted) }
 */
router.post('/:id/archive', (req, res) => {
  const shift = shiftService.archiveShift(Number(req.params.id))
  logActivity('shift', shift.id, req.session.userId, 'archived')
  res.json(ok(shift))
})

/**
 * @openapi
 * /shifts/{id}/unarchive:
 *   post: { tags: [Shifts], summary: Unarchive a shift note (return it to active lists) }
 */
router.post('/:id/unarchive', (req, res) => {
  const shift = shiftService.unarchiveShift(Number(req.params.id))
  logActivity('shift', shift.id, req.session.userId, 'unarchived')
  res.json(ok(shift))
})

/**
 * @openapi
 * /shifts/{id}/draft:
 *   post:
 *     tags: [Shifts]
 *     summary: AI clean-up of the worker's bullets into a draft note (Haiku; draft only)
 */
router.post('/:id/draft', validate(shiftDraftSchema), async (req, res, next) => {
  try {
    const shift = shiftService.getShift(Number(req.params.id))
    if (shift.finalised) throw new ApiError(409, 'FINALISED', 'Shift note is finalised')
    const bullets = req.body.bullets || shift.support_provided
    if (!bullets) throw new ApiError(409, 'NO_INPUT', 'Add support-provided bullets first')
    const client = clientService.getClient(shift.client_id)
    // minimise PII in prompts: preferred name or initials only
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    const body = await draftShiftNote({
      clientLabel: label,
      shiftDate: shift.shift_date,
      durationHours: shift.duration_hours,
      supportProvided: bullets,
      participantResponse: shift.participant_response,
      incident: shift.incident_flag ? shift.incident_details : null
    }, req.session.userId)
    const updated = shiftService.updateShift(shift.id, { body })
    res.json(ok({ ...updated, estimated_tokens: estimateTokens(bullets) }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /shifts/{id}/photos:
 *   post: { tags: [Shifts], summary: Upload a shift photo (served auth-gated only) }
 */
router.post('/:id/photos', photoUpload.single('photo'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'No photo uploaded (jpeg/png/webp only)'))
  const photo = shiftService.addPhoto(Number(req.params.id), req.file, req.body.caption)
  logActivity('shift', Number(req.params.id), req.session.userId, 'updated', { photo_added: true })
  res.status(201).json(ok(photo))
})

/** Auth-gated photo file serving — never exposed as a public static path. */
router.get('/:id/photos/:photoId/file', (req, res) => {
  const photo = shiftService.getPhoto(Number(req.params.id), Number(req.params.photoId))
  res.sendFile(path.resolve(PHOTO_DIR, photo.filename))
})

router.delete('/:id/photos/:photoId', (req, res) => {
  const photo = shiftService.deletePhoto(Number(req.params.id), Number(req.params.photoId))
  const file = path.join(PHOTO_DIR, photo.filename)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  logActivity('shift', Number(req.params.id), req.session.userId, 'updated', { photo_deleted: true })
  res.json(ok({ deleted: true }))
})

export default router
