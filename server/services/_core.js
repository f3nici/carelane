import crypto from 'node:crypto'
import { createServices } from '@carelane/core'
import config from '../config.js'
import { sqlite, db } from '../db/connection.js'

/**
 * The host context for `@carelane/core` on the server: the process-wide
 * `better-sqlite3` connection, the Drizzle instance, `node:crypto` as the
 * {@link import('@carelane/core').CoreContext} crypto provider, and the shared
 * `ENCRYPTION_SECRET`. Optional server-only integrations (e.g. Google Calendar)
 * register themselves onto this object after they load — core reads them lazily.
 * @type {import('@carelane/core').CoreContext}
 */
export const ctx = {
  db,
  sqlite,
  crypto,
  encryptionSecret: config.encryptionSecret,
  now: () => Date.now(),
  // Populated by googleCalendarService when it loads (server-only, optional).
  googleCalendar: null
}

/**
 * The assembled core domain services, built once from {@link ctx}. Server
 * service modules re-export the relevant bound functions from here so route
 * handlers keep importing `../services/<name>.js` unchanged.
 */
export const services = createServices(ctx)
