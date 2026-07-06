import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { validate } from '../middleware/validate.js'
import { requireAdmin, demoLock } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { askSchema } from '../utils/validators.js'
import * as documentService from '../services/documentService.js'
import { searchChunks, keywordSearch } from '../services/ragService.js'
import { sniffFileType, sanitizeDownloadName } from '../utils/fileType.js'
import { askGuidelines } from '../services/aiService.js'
import { logActivity } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()

const DOC_DIR = path.join(config.uploadPath, 'documents')
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(DOC_DIR, { recursive: true })
      cb(null, DOC_DIR)
    },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.pdf')
  }),
  limits: { fileSize: config.uploadLimitFor(50 * 1024 * 1024) },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
})

// Knowledge-base Q&A spends Claude tokens; cap per-operator call rate.
const askLimiter = rateLimit({ name: 'ask', max: 20, windowMs: 60 * 1000 })

/**
 * @openapi
 * /documents:
 *   get: { tags: [Knowledge], summary: List knowledge-base documents }
 *   post: { tags: [Knowledge], summary: Upload a PDF (indexed locally in the background) }
 */
router.get('/', (req, res) => {
  res.json(ok(documentService.listDocuments()))
})

router.post('/', requireAdmin, demoLock, upload.single('file'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'Upload a PDF file'))
  // Don't trust the client-declared Content-Type — confirm the saved file really
  // is a PDF from its magic bytes, deleting it on a mismatch.
  if (sniffFileType(req.file.path) !== 'application/pdf') {
    fs.rm(req.file.path, () => {})
    return next(new ApiError(400, 'UPLOAD_ERROR', 'File is not a valid PDF'))
  }
  const doc = documentService.createDocument(req.file, req.body)
  logActivity('document', doc.id, req.session.userId, 'created', { category: doc.category })
  res.status(201).json(ok(doc))
})

/**
 * @openapi
 * /documents/search:
 *   get: { tags: [Knowledge], summary: Semantic + keyword search over indexed chunks (fully local) }
 */
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 2000)
    if (!q) throw new ApiError(400, 'VALIDATION_ERROR', 'Provide a search query ?q=')
    const mode = req.query.mode === 'keyword' ? 'keyword' : 'semantic'
    const results = mode === 'keyword' ? keywordSearch(q, 10) : await searchChunks(q, 10)
    res.json(ok({ mode, results }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /documents/ask:
 *   post: { tags: [Knowledge], summary: Grounded Q&A — retrieve top-k chunks locally, answer via Claude with citations }
 */
router.post('/ask', demoLock, askLimiter, validate(askSchema), async (req, res, next) => {
  try {
    const result = await askGuidelines(req.body.question, req.session.userId)
    res.json(ok(result))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /documents/{id}/file:
 *   get: { tags: [Knowledge], summary: Download the original PDF (auth-gated) }
 */
router.get('/:id/file', (req, res, next) => {
  try {
    const doc = documentService.getDocument(Number(req.params.id))
    // Forward filesystem errors (e.g. a row whose file is missing) to a clean
    // 404 instead of leaking a path/stack — mirrors the client-document route.
    res.download(path.resolve(DOC_DIR, path.basename(doc.filename)), sanitizeDownloadName(doc.original_name, `${doc.title}.pdf`), err => {
      if (err && !res.headersSent) next(new ApiError(404, 'FILE_NOT_FOUND', 'Document file is unavailable'))
    })
  } catch (err) { next(err) }
})

router.post('/:id/reindex', requireAdmin, async (req, res, next) => {
  try {
    const chunks = await documentService.reindexDocument(Number(req.params.id))
    logActivity('document', Number(req.params.id), req.session.userId, 'updated', { reindexed: true, chunks })
    res.json(ok({ indexed: true, chunks }))
  } catch (err) { next(err) }
})

router.delete('/:id', requireAdmin, (req, res) => {
  documentService.deleteDocument(Number(req.params.id))
  logActivity('document', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

export default router
