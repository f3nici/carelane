import express from 'express'
import session from 'express-session'
import helmet from 'helmet'
import BetterSqlite3SessionStore from 'better-sqlite3-session-store'
import fs from 'node:fs'
import path from 'node:path'
import config from './config.js'
import { sqlite } from './db/connection.js'
import { requireAuth, csrfProtect } from './middleware/auth.js'
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
      const fields = { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }
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
  // METRICS_TOKEN when set (see metricsHandler).
  if (config.metricsEnabled) app.get('/metrics', metricsHandler(config))

  const api = express.Router()
  api.use(csrfProtect)
  api.use('/auth', authRoutes)
  api.use('/clients', requireAuth, clientRoutes)
  api.use('/agreements', requireAuth, agreementRoutes)
  api.use('/shifts', requireAuth, shiftRoutes)
  api.use('/incidents', requireAuth, incidentRoutes)
  api.use('/schedule', requireAuth, scheduleRoutes)
  api.use('/reports', requireAuth, reportRoutes)
  api.use('/billing-codes', requireAuth, billingRoutes)
  api.use('/invoices', requireAuth, invoiceRoutes)
  api.use('/documents', requireAuth, documentRoutes)
  api.use('/dashboard', requireAuth, dashboardRoutes)
  api.use('/settings', requireAuth, settingsRoutes)
  api.use('/notifications', requireAuth, notificationRoutes)
  api.use('/templates', requireAuth, templateRoutes)
  api.use('/audit', requireAuth, auditRoutes)
  api.use('/deleted', requireAuth, deletedRoutes)
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
