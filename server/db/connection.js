import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import config from '../config.js'
import * as schema from './schema.js'

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

export const sqlite = new Database(config.dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
// NORMAL is the recommended durability level under WAL: safe against application
// crashes (only an OS/power loss could lose the last commit, which the nightly
// backup covers) and a meaningful write-throughput gain over the FULL default.
sqlite.pragma('synchronous = NORMAL')
// Wait (up to 5s) for a competing writer to finish instead of failing a query
// immediately with SQLITE_BUSY — e.g. a CLI script (reindex/backup/restore) run
// while the server holds the write lock.
sqlite.pragma('busy_timeout = 5000')

/** Whether the sqlite-vec extension loaded (vector search available). */
export let vecAvailable = false
try {
  const sqliteVec = await import('sqlite-vec')
  sqliteVec.load(sqlite)
  vecAvailable = true
} catch (err) {
  console.warn('sqlite-vec extension unavailable, falling back to JS cosine similarity:', err.message)
}

export const db = drizzle(sqlite, { schema })
