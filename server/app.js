import express from 'express'
import session from 'express-session'
import helmet from 'helmet'
import BetterSqlite3SessionStore from 'better-sqlite3-session-store'
import fs from 'node:fs'
import path from 'node:path'
import config from './config.js'
import { sqlite } from './db/connection.js'
import { requireAuth, attachAccess, requireAdmin, csrfProtect } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import { mountSwagger } from './swagger.js'
import { logger } from './services/logger.js'
import { metricsMiddleware, metricsHandler } from './services/metrics.js'
import { touchSession } from './services/sessionService.js'

import authRoutes from './routes/auth.js'
import clientRoutes from './routes/clients.js'
import agreementRoutes from './routes/agreements.js'
import shiftRoutes from './routes/shifts.js'
import incidentRoutes from './routes/incidents.js'
import scheduleRoutes from './routes/schedule.js'
import reportRoutes from './routes/reports.js'
import billingRoutes from './routes/billing.js'
import invoiceRoutes from './routes/invoices.js'
import documentRoutes from './routes/documents.js'
import dashboardRoutes from './routes/dashboard.js'
import settingsRoutes from './routes/settings.js'
import notificationRoutes from './routes/notifications.js'
import templateRoutes from './routes/templates.js'
import auditRoutes from './routes/audit.js'
import deletedRoutes from './routes/deleted.js'
import userRoutes from './routes/users.js'
import calendarFeedRoutes from './routes/calendarFeed.js'
import shareLinkRoutes from './routes/shareLinks.js'
import sharePublicRoutes from './routes/sharePublic.js'

/**
 * Build the configured Express app (middleware + routes) without binding a
 * port. Kept separate from the bootstrap in index.js so integration tests can
 * drive the app with supertest. Assumes migrations/seed have already run.
 * @returns {import('express').Express}
 */
export function createApp () {
  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  // Structured access log + latency metrics. Records method, route and status —
  // never query strings or bodies, which may carry PII. /healthz and /metrics
  // are skipped so a monitoring scrape does not flood the log or its own series.
  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/metrics') return next()
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      // The iCal feed and share-link paths embed a secret token — log a redacted
      // form so the subscribe / share URL never lands in the access log.
      const loggedPath = req.path.startsWith('/calendar/')
        ? '/calendar/:token.ics'
        : req.path.startsWith('/share/') ? '/share/:token' : req.path
      const fields = { method: req.method, path: loggedPath, status: res.statusCode, ms: Math.round(ms) }
      if (res.statusCode >= 500) logger.error('request', fields)
      else if (res.statusCode >= 400) logger.warn('request', fields)
      else logger.info('request', fields)
    })
    next()
  })
  if (config.metricsEnabled) app.use(metricsMiddleware)

  // Security headers. CSP allows Google Fonts (used by index.html) and inline
  // styles (vue-cal positions events with inline styles; :style bindings). The
  // Swagger UI page at /api/docs needs inline script/style + data: images to
  // bootstrap, so it gets a relaxed policy; everything else is locked down.
  const strictCsp = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProduction ? [] : null
      }
    },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false
  })
  const swaggerCsp = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
  app.use((req, res, next) =>
    (req.path.startsWith('/api/docs') ? swaggerCsp : strictCsp)(req, res, next))

  app.use(express.json({ limit: '2mb' }))

  // CORS for the dev frontend only (prod is same-origin)
  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin && config.corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Access-Control-Allow-Credentials', 'true')
      res.set('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token')
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  const SqliteStore = BetterSqlite3SessionStore(session)
  app.use(session({
    store: new SqliteStore({ client: sqlite, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: config.sessionSecret,
    name: 'carelane.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // HTTPS-only in production (the app is expected to run behind a
      // TLS-terminating proxy — see `trust proxy`). A hard `true` prevents the
      // session cookie being sent or injected over plain HTTP.
      secure: config.isProduction,
      maxAge: 12 * 60 * 60 * 1000
    }
  }))

  // Refresh per-session device metadata (last-seen, IP, user-agent) so the
  // active-sessions list stays current. Throttled internally to one write per
  // session every few minutes.
  app.use(touchSession)

  /** Unauthenticated DB connectivity check for Docker healthcheck / monitoring. */
  app.get('/healthz', (req, res) => {
    try {
      sqlite.prepare('SELECT 1').get()
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'degraded' })
    }
  })

  // Prometheus metrics scrape (opt-in via METRICS_ENABLED). Mounted before the
  // session/auth stack so a scraper needs no cookie; access is gated by
  // METRICS_TOKEN when set, and otherwise restricted to a private/loopback source
  // address (see metricsHandler).
  if (config.metricsEnabled) app.get('/metrics', metricsHandler(config))

  // Public read-only iCal subscription feed. Mounted before the /api stack so it
  // needs no session or CSRF token — a calendar client subscribes with a bare
  // URL whose secret token is the only credential (see routes/calendarFeed.js).
  app.use('/calendar', calendarFeedRoutes)

  // Public, unauthenticated client-facing share links (landing page + download).
  // Mounted before the /api stack for the same reason as the calendar feed — the
  // recipient has no account and the secret token in the path is the credential.
  app.use('/share', sharePublicRoutes)

  const api = express.Router()
  api.use(csrfProtect)
  api.use('/auth', authRoutes)
  // Everything past here needs a session; `attachAccess` then resolves the
  // caller's role + assigned participants (and rejects a deactivated login).
  const authed = [requireAuth, attachAccess]
  api.use('/clients', authed, clientRoutes)
  // Service agreements are an operator surface — hidden from support workers.
  api.use('/agreements', authed, requireAdmin, agreementRoutes)
  api.use('/shifts', authed, shiftRoutes)
  api.use('/incidents', authed, incidentRoutes)
  api.use('/schedule', authed, scheduleRoutes)
  api.use('/reports', authed, reportRoutes)
  api.use('/billing-codes', authed, billingRoutes)
  api.use('/dashboard', authed, dashboardRoutes)
  api.use('/users', authed, userRoutes)
  // The knowledge base is readable by everyone (workers can search/reference the
  // guidelines) — only uploading/reindexing/deleting documents is admin-gated,
  // inside the router itself.
  api.use('/documents', authed, documentRoutes)
  // Settings reads (branding + AI integration status) are needed by every
  // client, workers included, so the router is mounted for all authenticated
  // users — each mutating route (PUT, logo, backups, AI test) carries its own
  // `requireAdmin`, and secrets are stripped from the read (see settingsService).
  api.use('/settings', authed, settingsRoutes)
  // Admin-only surfaces: invoicing, notifications, drafting templates, the audit
  // trail and the deleted-items recycle bin are operator tools a support worker
  // never touches.
  api.use('/invoices', authed, requireAdmin, invoiceRoutes)
  api.use('/notifications', authed, requireAdmin, notificationRoutes)
  api.use('/templates', authed, requireAdmin, templateRoutes)
  api.use('/audit', authed, requireAdmin, auditRoutes)
  api.use('/deleted', authed, requireAdmin, deletedRoutes)
  // Client-facing share links expose participant data outside the app, so
  // creating/managing them is an admin-only operator surface (the public side is
  // the unauthenticated /share routes mounted above).
  api.use('/share-links', authed, requireAdmin, shareLinkRoutes)
  app.use('/api/v1', api)

  // Interactive API docs (Swagger UI) describe the whole public API surface and
  // run with a relaxed inline-script CSP, so they are opt-in via PUBLIC_API_ENABLED
  // (default off) rather than exposed unauthenticated — mirroring /metrics.
  if (config.publicApiEnabled) mountSwagger(app)

  // Serve the built Vue app in production (uploads/ is deliberately NOT static)
  const distDir = path.resolve('dist')
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir))
    app.get(/^(?!\/(api|healthz|metrics)).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')))
  }

  app.use('/api', notFound)
  app.use(errorHandler)
  return app
}
