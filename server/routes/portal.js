import { Router } from 'express'
import path from 'node:path'
import { validate } from '../middleware/validate.js'
import { portalLoginSchema } from '../utils/validators.js'
import { ApiError } from '../middleware/errorHandler.js'
import { requirePortalAuth } from '../middleware/portalAuth.js'
import { ensureCsrfToken } from '../middleware/auth.js'
import * as portalService from '../services/portalService.js'
import { getSettings } from '../services/settingsService.js'
import { CLIENT_DOC_DIR } from '../services/clientDocumentService.js'
import { sanitizeDownloadName } from '../utils/fileType.js'
import { logActivity } from '../services/activityService.js'
import { throttleKey, checkLockout, recordFailure, clearAttempts } from '../services/loginThrottle.js'
import { isDemo, DEMO_PORTAL_USERNAME, DEMO_PASSWORD } from '../services/demoService.js'
import { parsePagination, paginationMeta, ok } from '../utils/pagination.js'
import config from '../config.js'

/**
 * Client-portal API. A participant-facing, READ-ONLY surface, mounted at
 * `/api/v1/portal` but deliberately OUTSIDE the staff `requireAuth`/`attachAccess`
 * stack — a portal session carries only `req.session.portalClientId`, so it can
 * never reach a staff route, and every read here is scoped to that one
 * participant. The only writes are login/logout; `/auth/login` is CSRF-exempt in
 * the api-level `csrfProtect` (like the staff login), and logout echoes the
 * portal CSRF token.
 */
const router = Router()

const PHOTO_DIR = path.join(config.uploadPath, 'photos')

/**
 * @openapi
 * /portal/auth/config:
 *   get: { tags: [Portal], summary: Unauthenticated portal bootstrap (branding + demo creds) }
 */
router.get('/auth/config', (req, res) => {
  const s = getSettings()
  res.json(ok({
    business_name: s.business_name || 'CareLane',
    brand_primary_color: s.brand_primary_color || '#2563eb',
    ...(isDemo()
      ? { demo: true, demo_username: DEMO_PORTAL_USERNAME, demo_password: DEMO_PASSWORD }
      : { demo: false })
  }))
})

/**
 * @openapi
 * /portal/auth/login:
 *   post: { tags: [Portal], summary: Client-portal login (username + password) }
 */
router.post('/auth/login', validate(portalLoginSchema), (req, res, next) => {
  // Reuse the DB-backed brute-force throttle, namespaced so portal attempts never
  // interact with the staff login buckets.
  const key = throttleKey(req.ip, 'portal:' + req.body.username)
  const lock = checkLockout(key)
  if (lock.locked) {
    return next(new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} minute(s).`))
  }
  const account = portalService.verifyLogin(req.body.username, req.body.password)
  if (!account) {
    recordFailure(key)
    return next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'))
  }
  clearAttempts(key)
  req.session.regenerate(err => {
    if (err) return next(err)
    // A portal session stores ONLY the participant id — never a staff userId —
    // so it can never satisfy the staff auth middleware.
    req.session.portalClientId = account.client_id
    const csrf = ensureCsrfToken(req.session)
    portalService.touchLogin(account.id)
    const context = portalService.loadPortalContext(account.client_id)
    logActivity('client', account.client_id, null, 'portal_login')
    res.json(ok({
      client_id: account.client_id,
      participant_label: context?.participantLabel,
      demo: isDemo(),
      csrf_token: csrf
    }))
  })
})

/**
 * @openapi
 * /portal/auth/logout:
 *   post: { tags: [Portal], summary: End the client-portal session }
 */
router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json(ok({ logged_out: true })))
})

/**
 * @openapi
 * /portal/auth/me:
 *   get: { tags: [Portal], summary: Current portal participant (and CSRF token) }
 */
router.get('/auth/me', requirePortalAuth, (req, res) => {
  res.json(ok({
    client_id: req.portal.clientId,
    participant_label: req.portal.participantLabel,
    demo: isDemo(),
    csrf_token: ensureCsrfToken(req.session)
  }))
})

/**
 * @openapi
 * /portal/shift-notes:
 *   get: { tags: [Portal], summary: List the participant's finalised shift notes }
 */
router.get('/shift-notes', requirePortalAuth, (req, res) => {
  const pg = parsePagination(req.query)
  const { rows, total } = portalService.listNotes(req.portal.clientId, pg)
  res.json(ok(rows, paginationMeta(pg.page, pg.perPage, total)))
})

/**
 * @openapi
 * /portal/shift-notes/{id}:
 *   get: { tags: [Portal], summary: Fetch one of the participant's finalised shift notes }
 */
router.get('/shift-notes/:id', requirePortalAuth, (req, res, next) => {
  try {
    res.json(ok(portalService.getNote(req.portal.clientId, Number(req.params.id))))
  } catch (err) { next(err) }
})

/** Auth-gated photo serving — scoped to the participant's own finalised notes. */
router.get('/shift-notes/:id/photos/:photoId/file', requirePortalAuth, (req, res, next) => {
  try {
    const photo = portalService.getNotePhoto(req.portal.clientId, Number(req.params.id), Number(req.params.photoId))
    res.sendFile(path.resolve(PHOTO_DIR, path.basename(photo.filename)), err => {
      if (err && !res.headersSent) next(new ApiError(404, 'FILE_NOT_FOUND', 'Photo file is unavailable'))
    })
  } catch (err) { next(err) }
})

/**
 * @openapi
 * /portal/documents:
 *   get: { tags: [Portal], summary: List the participant's completed documents }
 */
router.get('/documents', requirePortalAuth, (req, res) => {
  res.json(ok(portalService.listDocuments(req.portal.clientId)))
})

/** Auth-gated document download — scoped to the participant's own documents. */
router.get('/documents/:id/file', requirePortalAuth, (req, res, next) => {
  try {
    const doc = portalService.getDocument(req.portal.clientId, Number(req.params.id))
    res.download(path.resolve(CLIENT_DOC_DIR, path.basename(doc.filename)), sanitizeDownloadName(doc.original_name, doc.filename), err => {
      if (err && !res.headersSent) next(new ApiError(404, 'FILE_NOT_FOUND', 'Document file is unavailable'))
    })
  } catch (err) { next(err) }
})

export default router
