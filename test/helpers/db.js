import os from 'node:os'
import path from 'node:path'

/**
 * Point the app at a throwaway SQLite database and run migrations, then return
 * the freshly-loaded db modules. Must be called inside `beforeAll` BEFORE any
 * server module is imported in the test file — config/connection read DB_PATH at
 * import time, so the dynamic imports here pick up the temp path.
 * @returns {Promise<{ dbPath:string, sqlite:import('better-sqlite3').Database, migrate:Function }>}
 */
export async function freshDb () {
  const dbPath = path.join(os.tmpdir(), `carelane-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  process.env.DB_PATH = dbPath
  process.env.NODE_ENV = 'test'
  process.env.ENCRYPTION_SECRET ||= 'carelane-test-encryption-secret'
  process.env.SESSION_SECRET ||= 'carelane-test-session-secret'
  const { migrate } = await import('../../server/db/migrate.js')
  migrate()
  const { sqlite } = await import('../../server/db/connection.js')
  return { dbPath, sqlite, migrate }
}
