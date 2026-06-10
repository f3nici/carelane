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
