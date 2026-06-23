import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { validate } from '../middleware/validate.js'
import { settingsSchema } from '../utils/validators.js'
import { requireAdmin } from '../middleware/auth.js'
import { getSettings, updateSettings, getSetting } from '../services/settingsService.js'
import { logActivity } from '../services/activityService.js'
import { runBackup, listBackups, verifyBackup, backupFreshness } from '../services/backupService.js'
import { aiStatus, testConnection as testAiConnection } from '../services/aiService.js'
import { sniffFileType } from '../utils/fileType.js'
import { ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

const LOGO_DIR = path.join(config.uploadPath, 'logos')
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(LOGO_DIR, { recursive: true })
      cb(null, LOGO_DIR)
    },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype))
})

/**
 * @openapi
 * /settings:
 *   get: { tags: [Settings], summary: All settings (branding, AI models, business details) }
 *   put: { tags: [Settings], summary: Update settings (admin only) }
 */
router.get('/', (req, res) => {
  res.json(ok(getSettings()))
})

router.put('/', requireAdmin, validate(settingsSchema), (req, res) => {
  const updated = updateSettings(req.body)
  logActivity('settings', null, req.session.userId, 'updated', { keys: Object.keys(req.body).join(',') })
  res.json(ok(updated))
})

/**
 * @openapi
 * /settings/ai/status:
 *   get: { tags: [Settings], summary: Claude API configuration + active model ids }
 */
router.get('/ai/status', (req, res) => {
  res.json(ok(aiStatus()))
})

/**
 * @openapi
 * /settings/ai/test:
 *   post: { tags: [Settings], summary: Test connectivity to the Claude API (admin only) }
 */
router.post('/ai/test', requireAdmin, async (req, res, next) => {
  try {
    const result = await testAiConnection()
    logActivity('settings', null, req.session.userId, 'ai_test', { ok: result.ok ? 1 : 0 })
    res.json(ok(result))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /settings/logo:
 *   post: { tags: [Settings], summary: Upload the business logo (admin only) }
 */
const LOGO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' }

router.post('/logo', requireAdmin, upload.single('logo'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'Upload a png/jpeg/webp/svg logo'))
  // multer's fileFilter only saw the forgeable client Content-Type. Confirm the
  // real type from the file's contents — and normalise the on-disk extension to
  // match — so arbitrary bytes can't be stored (and later served) under a
  // mislabelled image extension. The serving route additionally locks any SVG
  // down with a restrictive CSP, but verifying it really is an image first keeps
  // the logo store consistent with the photo/document upload paths.
  const detected = sniffFileType(req.file.path)
  if (!detected || !LOGO_EXT[detected]) {
    fs.rm(req.file.path, () => {})
    return next(new ApiError(400, 'UPLOAD_ERROR', 'File contents are not a valid png/jpeg/webp/svg image'))
  }
  const safeExt = LOGO_EXT[detected]
  if (path.extname(req.file.filename).toLowerCase() !== safeExt) {
    const renamed = path.basename(req.file.filename, path.extname(req.file.filename)) + safeExt
    fs.renameSync(req.file.path, path.join(LOGO_DIR, renamed))
    req.file.filename = renamed
  }
  updateSettings({ logo_filename: req.file.filename })
  logActivity('settings', null, req.session.userId, 'updated', { logo: true })
  res.status(201).json(ok({ logo_filename: req.file.filename }))
})

/** Auth-gated logo serving (uploads are never publicly static). */
router.get('/logo', (req, res, next) => {
  const filename = getSetting('logo_filename')
  if (!filename) return next(new ApiError(404, 'NOT_FOUND', 'No logo uploaded'))
  // The logo may be an SVG. SVGs don't execute script when loaded via <img>, but
  // a direct navigation to this URL could; lock the response down so an uploaded
  // SVG can never run script regardless of how it's loaded.
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:")
  res.set('X-Content-Type-Options', 'nosniff')
  res.sendFile(path.resolve(LOGO_DIR, path.basename(filename)), err => {
    if (err && !res.headersSent) next(new ApiError(404, 'NOT_FOUND', 'Logo file is unavailable'))
  })
})

/**
 * @openapi
 * /settings/backups:
 *   get: { tags: [Settings], summary: List backup snapshots and freshness (admin only) }
 */
router.get('/backups', requireAdmin, (req, res) => {
  res.json(ok({ freshness: backupFreshness(), backups: listBackups() }))
})

/**
 * @openapi
 * /settings/backups/run:
 *   post: { tags: [Settings], summary: Run a backup now (admin only) }
 */
router.post('/backups/run', requireAdmin, async (req, res, next) => {
  try {
    const result = await runBackup()
    logActivity('backup', null, req.session.userId, 'created_manual')
    res.status(201).json(ok({ db: path.basename(result.db), uploads: result.uploads ? path.basename(result.uploads) : null, freshness: backupFreshness() }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /settings/backups/{filename}/verify:
 *   get: { tags: [Settings], summary: Integrity-check a backup snapshot (admin only) }
 */
router.get('/backups/:filename/verify', requireAdmin, (req, res, next) => {
  try {
    res.json(ok(verifyBackup(req.params.filename)))
  } catch (err) {
    next(new ApiError(400, 'BACKUP_VERIFY_FAILED', err.message))
  }
})

export default router
