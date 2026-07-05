import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { validate, validatePartial } from '../middleware/validate.js'
import { shiftSchema, shiftDraftSchema } from '../utils/validators.js'
import * as shiftService from '../services/shiftService.js'
import * as clientService from '../services/clientService.js'
import { assertClientAccess, requireAdmin } from '../middleware/auth.js'
import { draftShiftNote, estimateShiftNoteTokens } from '../services/aiService.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { sniffFileType } from '../utils/fileType.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

const PHOTO_DIR = path.join(config.uploadPath, 'photos')
const MEDIA_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp']
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(PHOTO_DIR, { recursive: true })
      cb(null, PHOTO_DIR)
    },
    // non-guessable filename: photos/videos may contain PII and are served only behind auth
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: config.uploadLimitFor(200 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    cb(null, MEDIA_MIMES.includes(file.mimetype))
  }
})

// Access control: every `:id` route is checked against the note's participant so
// a worker can only reach notes for their assigned participants. A worker may
// create a note, view every note, and edit/finalise/add photos to their OWN
// note while it is still a draft — but once it is finalised they cannot edit it
// or send it back to draft. Deleting, archiving, AI-drafting and reopening a
// finalised note are admin-only. (Enforced by `canEditNote` + `requireAdmin`.)
router.param('id', (req, res, next, value) => {
  try {
    const shift = shiftService.getShift(Number(value))
    assertClientAccess(req, shift.client_id)
    req.shift = shift
    next()
  } catch (err) { next(err) }
})

/**
 * Allow editing a note only when the caller may write it: an admin always, or a
 * worker for their OWN note while it is still a draft. Once finalised a worker
 * can neither edit it nor send it back to draft (only an admin can reopen), and
 * a worker can never touch another person's note. Relies on `req.shift` set by
 * the `:id` param guard above.
 */
function canEditNote (req, res, next) {
  if (req.isAdmin) return next()
  if (req.shift?.worker_id === req.currentUser.id && !req.shift.finalised) return next()
  next(new ApiError(403, 'FORBIDDEN', "You don't have access to this"))
}

/**
 * @openapi
 * /shifts:
 *   get: { tags: [Shifts], summary: List shift notes }
 *   post: { tags: [Shifts], summary: Create a shift note }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = shiftService.listShifts(pg, { ...req.query, client_ids: req.assignedClientIds })
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(shiftSchema), (req, res) => {
  // A worker may only note a shift for a participant assigned to them.
  assertClientAccess(req, Number(req.body.client_id))
  const shift = shiftService.createShift(req.body, req.session.userId)
  logActivity('shift', shift.id, req.session.userId, 'created', { incident: !!shift.incident_flag })
  res.status(201).json(ok(shift))
})

router.get('/:id', (req, res) => {
  res.json(ok(shiftService.getShift(Number(req.params.id))))
})

router.put('/:id', canEditNote, validatePartial(shiftSchema), (req, res) => {
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

router.delete('/:id', requireAdmin, (req, res) => {
  shiftService.deleteShift(Number(req.params.id))
  logActivity('shift', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /shifts/{id}/archive:
 *   post: { tags: [Shifts], summary: Archive a shift note (hidden from active lists, not deleted) }
 */
router.post('/:id/archive', requireAdmin, (req, res) => {
  const shift = shiftService.archiveShift(Number(req.params.id))
  logActivity('shift', shift.id, req.session.userId, 'archived')
  res.json(ok(shift))
})

/**
 * @openapi
 * /shifts/{id}/unarchive:
 *   post: { tags: [Shifts], summary: Unarchive a shift note (return it to active lists) }
 */
router.post('/:id/unarchive', requireAdmin, (req, res) => {
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
const aiLimiter = rateLimit({ name: 'ai-draft', max: 20, windowMs: 60 * 1000 })

router.post('/:id/draft', requireAdmin, aiLimiter, validate(shiftDraftSchema), async (req, res, next) => {
  try {
    const shift = shiftService.getShift(Number(req.params.id))
    if (shift.finalised) throw new ApiError(409, 'FINALISED', 'Shift note is finalised')
    const bullets = req.body.bullets || shift.support_provided
    if (!bullets) throw new ApiError(409, 'NO_INPUT', 'Add support-provided bullets first')
    const client = clientService.getClient(shift.client_id)
    // minimise PII in prompts: preferred name or initials only
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    const { body, usage } = await draftShiftNote({
      clientLabel: label,
      shiftDate: shift.shift_date,
      durationHours: shift.duration_hours,
      supportProvided: bullets,
      participantResponse: shift.participant_response,
      incident: shift.incident_flag ? shift.incident_details : null
    }, req.session.userId)
    const updated = shiftService.updateShift(shift.id, { body })
    res.json(ok({ ...updated, tokens: usage }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /shifts/{id}/draft/estimate:
 *   post: { tags: [Shifts], summary: Estimate the draft's input tokens (no AI call) }
 */
router.post('/:id/draft/estimate', (req, res, next) => {
  try {
    const shift = shiftService.getShift(Number(req.params.id))
    const client = clientService.getClient(shift.client_id)
    const label = client.preferred_name || `${client.first_name?.[0] || ''}${client.last_name?.[0] || ''}`.toUpperCase()
    const estimated_tokens = estimateShiftNoteTokens({
      clientLabel: label,
      shiftDate: shift.shift_date,
      durationHours: shift.duration_hours,
      supportProvided: req.body.bullets ?? shift.support_provided ?? '',
      participantResponse: shift.participant_response,
      incident: shift.incident_flag ? shift.incident_details : null
    })
    res.json(ok({ estimated_tokens }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /shifts/{id}/photos:
 *   post: { tags: [Shifts], summary: Upload a shift photo (served auth-gated only) }
 */
const MEDIA_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp'
}

router.post('/:id/photos', canEditNote, photoUpload.single('photo'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'No file uploaded (jpeg/png/webp/mp4/mov/webm only)'))
  // The fileFilter only sees the forgeable client Content-Type. Confirm the real
  // type from magic bytes, and normalise the on-disk extension to the detected
  // type — the file is served inline, so a mislabelled .html/.svg extension
  // taken from the original filename could otherwise be served as active content.
  const detected = sniffFileType(req.file.path)
  if (!detected || !MEDIA_EXT[detected]) {
    fs.rm(req.file.path, () => {})
    return next(new ApiError(400, 'UPLOAD_ERROR', 'File contents are not a supported image or video (jpeg/png/webp/mp4/mov/webm)'))
  }
  const safeExt = MEDIA_EXT[detected]
  if (path.extname(req.file.filename).toLowerCase() !== safeExt) {
    const renamed = path.basename(req.file.filename, path.extname(req.file.filename)) + safeExt
    fs.renameSync(req.file.path, path.join(PHOTO_DIR, renamed))
    req.file.filename = renamed
    req.file.path = path.join(PHOTO_DIR, renamed)
  }
  req.file.mimetype = detected
  const photo = shiftService.addPhoto(Number(req.params.id), req.file, req.body.caption)
  logActivity('shift', Number(req.params.id), req.session.userId, 'updated', { photo_added: true })
  res.status(201).json(ok(photo))
})

/** Auth-gated photo file serving — never exposed as a public static path. */
router.get('/:id/photos/:photoId/file', (req, res, next) => {
  const photo = shiftService.getPhoto(Number(req.params.id), Number(req.params.photoId))
  res.sendFile(path.resolve(PHOTO_DIR, path.basename(photo.filename)), err => {
    if (err && !res.headersSent) next(new ApiError(404, 'FILE_NOT_FOUND', 'Photo file is unavailable'))
  })
})

router.delete('/:id/photos/:photoId', canEditNote, (req, res) => {
  const photo = shiftService.deletePhoto(Number(req.params.id), Number(req.params.photoId))
  const file = path.join(PHOTO_DIR, photo.filename)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  logActivity('shift', Number(req.params.id), req.session.userId, 'updated', { photo_deleted: true })
  res.json(ok({ deleted: true }))
})

export default router
