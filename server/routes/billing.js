import { Router } from 'express'
import multer from 'multer'
import { validate, validatePartial } from '../middleware/validate.js'
import { billingCodeSchema, billingImportCommitSchema } from '../utils/validators.js'
import * as billingService from '../services/billingService.js'
import { parsePriceGuideDocx, parsePriceGuidePdfText } from '../utils/docxParser.js'
import { extractPdfPages } from '../services/documentService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

const router = Router()
// Support items are a shared catalogue: any authenticated user may read them
// (a worker picks a code when noting a shift), but only an admin maintains the
// list — creating, editing, deactivating and importing are admin-only.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.isAdmin) return next()
  next(new ApiError(403, 'FORBIDDEN', 'Admin access required'))
})
// Price-guide imports are buffered in memory then parsed (docx/pdf), so keep the
// cap modest to bound memory use; a deliberately-lowered global limit wins.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadLimitFor(15 * 1024 * 1024) } })

/**
 * @openapi
 * /billing-codes:
 *   get: { tags: [Billing], summary: List NDIS support items }
 *   post: { tags: [Billing], summary: Create a support item manually }
 */
router.get('/', (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = billingService.listBillingCodes(pg, req.query)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

router.post('/', validate(billingCodeSchema), (req, res) => {
  const code = billingService.createBillingCode(req.body)
  logActivity('billing_code', code.id, req.session.userId, 'created', { code: code.code })
  res.status(201).json(ok(code))
})

router.put('/:id', validatePartial(billingCodeSchema), (req, res) => {
  const before = billingService.getBillingCode(Number(req.params.id))
  const code = billingService.updateBillingCode(Number(req.params.id), req.body)
  logActivity('billing_code', code.id, req.session.userId, 'updated', { code: code.code, changes: diffChanges(before, code, Object.keys(req.body)) })
  res.json(ok(code))
})

/** Deactivates only — billing history must be kept for past claims. */
router.delete('/:id', (req, res) => {
  billingService.deactivateBillingCode(Number(req.params.id))
  logActivity('billing_code', Number(req.params.id), req.session.userId, 'status_changed', { active: false })
  res.json(ok({ deactivated: true }))
})

/**
 * @openapi
 * /billing-codes/import:
 *   post:
 *     tags: [Billing]
 *     summary: Parse an NDIS price guide (.docx preferred, PDF fallback) into preview rows. Parsing is fully local — nothing is sent to the Claude API.
 */
router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'UPLOAD_ERROR', 'Upload the price guide as .docx (preferred) or PDF')
    const name = (req.file.originalname || '').toLowerCase()
    let rows
    let warning = null
    if (name.endsWith('.docx')) {
      rows = await parsePriceGuideDocx(req.file.buffer)
    } else if (name.endsWith('.pdf')) {
      const { pages } = await extractPdfPages(req.file.buffer)
      rows = parsePriceGuidePdfText(pages.join('\n'))
      warning = 'PDF import is less reliable than the Word document — review low-confidence rows carefully.'
    } else {
      throw new ApiError(400, 'UNSUPPORTED_FORMAT', 'Only .docx or .pdf price guides are supported')
    }
    if (!rows.length) throw new ApiError(422, 'NO_ROWS', 'No support items could be parsed from the file')
    res.json(ok({ rows, warning, low_confidence: rows.filter(r => r.confidence === 'low').length }))
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /billing-codes/import/commit:
 *   post:
 *     tags: [Billing]
 *     summary: Commit reviewed import rows (update by code, insert new, optionally deactivate missing)
 */
router.post('/import/commit', validate(billingImportCommitSchema), (req, res) => {
  const stats = billingService.commitImport(req.body)
  logActivity('billing_code', null, req.session.userId, 'updated', { import: true, version: req.body.price_guide_version, ...stats })
  res.json(ok(stats))
})

export default router
