import express from 'express'
import session from 'express-session'
import BetterSqlite3SessionStore from 'better-sqlite3-session-store'
import fs from 'node:fs'
import path from 'node:path'
import config from './config.js'
import { sqlite } from './db/connection.js'
import { requireAuth, csrfProtect } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import { mountSwagger } from './swagger.js'

import authRoutes from './routes/auth.js'
import clientRoutes from './routes/clients.js'
import agreementRoutes from './routes/agreements.js'
import shiftRoutes from './routes/shifts.js'
import reportRoutes from './routes/reports.js'
import billingRoutes from './routes/billing.js'
import documentRoutes from './routes/documents.js'
import dashboardRoutes from './routes/dashboard.js'
import settingsRoutes from './routes/settings.js'
import auditRoutes from './routes/audit.js'

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
      secure: config.isProduction ? 'auto' : false,
      maxAge: 12 * 60 * 60 * 1000
    }
  }))

  /** Unauthenticated DB connectivity check for Docker healthcheck / monitoring. */
  app.get('/healthz', (req, res) => {
    try {
      sqlite.prepare('SELECT 1').get()
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'degraded' })
    }
  })

  const api = express.Router()
  api.use(csrfProtect)
  api.use('/auth', authRoutes)
  api.use('/clients', requireAuth, clientRoutes)
  api.use('/agreements', requireAuth, agreementRoutes)
  api.use('/shifts', requireAuth, shiftRoutes)
  api.use('/reports', requireAuth, reportRoutes)
  api.use('/billing-codes', requireAuth, billingRoutes)
  api.use('/documents', requireAuth, documentRoutes)
  api.use('/dashboard', requireAuth, dashboardRoutes)
  api.use('/settings', requireAuth, settingsRoutes)
  api.use('/audit', requireAuth, auditRoutes)
  app.use('/api/v1', api)

  mountSwagger(app)

  // Serve the built Vue app in production (uploads/ is deliberately NOT static)
  const distDir = path.resolve('dist')
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir))
    app.get(/^(?!\/(api|healthz)).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')))
  }

  app.use('/api', notFound)
  app.use(errorHandler)
  return app
}
