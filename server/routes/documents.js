import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { validate } from '../middleware/validate.js'
import { askSchema } from '../utils/validators.js'
import * as documentService from '../services/documentService.js'
import { searchChunks, keywordSearch } from '../services/ragService.js'
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
  limits: { fileSize: Math.max(config.maxUploadSize, 50 * 1024 * 1024) },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
})

/**
 * @openapi
 * /documents:
 *   get: { tags: [Knowledge], summary: List knowledge-base documents }
 *   post: { tags: [Knowledge], summary: Upload a PDF (indexed locally in the background) }
 */
router.get('/', (req, res) => {
  res.json(ok(documentService.listDocuments()))
})

router.post('/', upload.single('file'), (req, res, next) => {
  if (!req.file) return next(new ApiError(400, 'UPLOAD_ERROR', 'Upload a PDF file'))
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
    const q = String(req.query.q || '').trim()
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
router.post('/ask', validate(askSchema), async (req, res, next) => {
  try {
    const result = await askGuidelines(req.body.question, req.session.userId)
    res.json(ok(result))
  } catch (err) { next(err) }
})

router.post('/:id/reindex', async (req, res, next) => {
  try {
    const chunks = await documentService.reindexDocument(Number(req.params.id))
    logActivity('document', Number(req.params.id), req.session.userId, 'updated', { reindexed: true, chunks })
    res.json(ok({ indexed: true, chunks }))
  } catch (err) { next(err) }
})

router.delete('/:id', (req, res) => {
  documentService.deleteDocument(Number(req.params.id))
  logActivity('document', Number(req.params.id), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

export default router
