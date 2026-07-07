import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import * as shareLinkService from '../services/shareLinkService.js'
import { getReport } from '../services/reportService.js'
import { getClientDocument, CLIENT_DOC_DIR } from '../services/clientDocumentService.js'
import { getSettings } from '../services/settingsService.js'
import { renderPdf, pdfPath, safeFilename } from '../utils/pdfRenderer.js'
import { sanitizeDownloadName } from '../utils/fileType.js'
import { demoLock } from '../middleware/auth.js'

/**
 * Public, unauthenticated share-link endpoints. Mounted at `/share`, OUTSIDE the
 * `/api/v1` session + CSRF stack, because the recipient (a plan manager or the
 * participant) has no CareLane account — the unguessable token in the URL is the
 * only credential, exactly like the calendar feed. Read-only (GET) so there is
 * no state-changing action for CSRF to protect.
 *
 * Two steps, deliberately: `GET /share/:token` shows a minimal branded landing
 * page describing what is shared (no content, so a link-preview scanner never
 * pulls the file), and `GET /share/:token/download` is the actual fetch — which
 * is what gets counted and written to the audit trail. Every non-active state
 * (unknown / expired / revoked / view-limit reached) renders a friendly page,
 * never a stack trace or the underlying resource.
 */
const router = Router()

/** HTML-escape a value for safe interpolation into the landing markup. */
function esc (value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A friendly date like "7 July 2026" from an ISO timestamp. */
function niceDate (iso) {
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  } catch { return iso }
}

/**
 * Wrap page content in a minimal, self-contained branded shell. No external
 * assets (the CSP forbids them and the branding logo is auth-gated), so branding
 * is the business name + accent colour only.
 * @param {string} bodyHtml
 * @param {string} title
 */
function page (bodyHtml, title) {
  const settings = getSettings()
  const brand = settings.brand_primary_color || '#2563eb'
  const business = esc(settings.business_name || 'CareLane')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; color: #1f2430; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #14161c; color: #e7e9ee; } .card { background: #1d212b !important; } }
  .card { background: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.12); max-width: 460px; width: 100%; padding: 32px; }
  .brand { font-weight: 700; font-size: 18px; color: ${esc(brand)}; margin: 0 0 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { font-size: 14px; color: #6b7280; margin: 4px 0; }
  .btn { display: inline-block; margin-top: 20px; background: ${esc(brand)}; color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 600; }
  .foot { margin-top: 24px; font-size: 12px; color: #9aa1ac; }
  .warn { color: #b45309; }
</style>
</head>
<body>
  <div class="card">
    <p class="brand">${business}</p>
    ${bodyHtml}
    <p class="foot">Shared securely via CareLane. This link is private — please do not forward it.</p>
  </div>
</body>
</html>`
}

/** Friendly page + status for a non-active (or unknown) link state. */
function unavailable (state) {
  const messages = {
    not_found: ['Link not found', 'This share link is not valid. Check that you copied the whole URL.'],
    expired: ['This link has expired', 'The share link has passed its expiry date. Ask your provider for a new one.'],
    revoked: ['This link is no longer available', 'The share link has been revoked by your provider.'],
    exhausted: ['This link has reached its view limit', 'The share link has already been opened the maximum number of times. Ask your provider for a new one.']
  }
  const [title, detail] = messages[state] || messages.not_found
  const status = state === 'not_found' ? 404 : 410
  const html = page(`<h1>${esc(title)}</h1><p class="meta warn">${esc(detail)}</p>`, title)
  return { status, html }
}

/**
 * @openapi
 * /share/{token}:
 *   get: { tags: [ShareLinks], summary: Public landing page describing a shared item (no content) }
 */
router.get('/:token', (req, res) => {
  const resolved = shareLinkService.resolveByToken(req.params.token)
  res.set('Cache-Control', 'private, no-store')
  if (!resolved) {
    const { status, html } = unavailable('not_found')
    return res.status(status).type('html').send(html)
  }
  if (resolved.state !== 'active') {
    const { status, html } = unavailable(resolved.state)
    return res.status(status).type('html').send(html)
  }

  let info
  try {
    info = shareLinkService.describeLink(resolved.link)
  } catch {
    // The underlying resource has since been deleted — treat as unavailable.
    const { status, html } = unavailable('not_found')
    return res.status(status).type('html').send(html)
  }

  const remaining = info.views_remaining == null
    ? ''
    : `<p class="meta">Views remaining: ${esc(info.views_remaining)}</p>`
  const body = `
    <h1>${esc(info.title)}</h1>
    <p class="meta">Prepared for ${esc(info.participant_label)}</p>
    <p class="meta">Available until ${esc(niceDate(info.expires_at))}</p>
    ${remaining}
    <a class="btn" href="/share/${esc(req.params.token)}/download">Download</a>`
  res.type('html').send(page(body, info.title))
})

/**
 * @openapi
 * /share/{token}/download:
 *   get: { tags: [ShareLinks], summary: Fetch the shared report/document (counted + audited) }
 */
router.get('/:token/download', demoLock, async (req, res, next) => {
  const resolved = shareLinkService.resolveByToken(req.params.token)
  res.set('Cache-Control', 'private, no-store')
  if (!resolved || resolved.state !== 'active') {
    const { status, html } = unavailable(resolved ? resolved.state : 'not_found')
    return res.status(status).type('html').send(html)
  }
  const { link } = resolved

  try {
    if (link.resource_type === 'report') {
      const report = getReport(link.resource_id)
      if (report.status !== 'final' || !report.body_markdown) {
        const { status, html } = unavailable('not_found')
        return res.status(status).type('html').send(html)
      }
      const docTitle = `${report.report_type.replace('_', ' ')} report`
      const filename = await renderPdf({
        title: docTitle,
        subtitle: `Period ${report.period_start || ''} to ${report.period_end || ''}`,
        body: report.body_markdown
      })
      // Content confirmed — count + audit this access, then stream the PDF and
      // clean up the freshly-rendered temp file afterwards.
      shareLinkService.recordAccess(link)
      return res.download(pdfPath(filename), safeFilename(docTitle, `report-${report.id}`), () => {
        try { fs.rmSync(pdfPath(filename)) } catch { /* already gone */ }
      })
    }

    if (link.resource_type === 'client_document') {
      const doc = getClientDocument(link.client_id, link.resource_id)
      const filePath = path.resolve(CLIENT_DOC_DIR, path.basename(doc.filename))
      if (!fs.existsSync(filePath)) {
        const { status, html } = unavailable('not_found')
        return res.status(status).type('html').send(html)
      }
      shareLinkService.recordAccess(link)
      return res.download(filePath, sanitizeDownloadName(doc.original_name, doc.filename), err => {
        if (err && !res.headersSent) {
          const { status, html } = unavailable('not_found')
          res.status(status).type('html').send(html)
        }
      })
    }

    const { status, html } = unavailable('not_found')
    return res.status(status).type('html').send(html)
  } catch (err) {
    // A missing/deleted underlying resource (404 from the service) becomes a
    // friendly unavailable page rather than a raw error.
    if (err?.status === 404 || err?.code === 'NOT_FOUND') {
      const { status, html } = unavailable('not_found')
      return res.status(status).type('html').send(html)
    }
    next(err)
  }
})

export default router
