import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import cron from 'node-cron'
import { sqlite } from '../db/connection.js'
import { logActivity } from './activityService.js'
import config from '../config.js'

const execFileAsync = promisify(execFile)

/**
 * Run a backup now: `VACUUM INTO` a dated SQLite snapshot plus a tar of the
 * uploads directory, then apply retention.
 * @returns {Promise<{db:string, uploads:string|null}>}
 */
export async function runBackup () {
  fs.mkdirSync(config.backupPath, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dbFile = path.join(config.backupPath, `carelane-${stamp}.db`)
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  sqlite.prepare('VACUUM INTO ?').run(dbFile)

  let uploadsFile = null
  if (fs.existsSync(config.uploadPath)) {
    uploadsFile = path.join(config.backupPath, `uploads-${stamp}.tar`)
    try {
      await execFileAsync('tar', ['-cf', uploadsFile, '-C', path.dirname(path.resolve(config.uploadPath)), path.basename(config.uploadPath)])
    } catch (err) {
      uploadsFile = null
      console.error('uploads backup failed:', err.message)
    }
  }
  applyRetention()
  logActivity('backup', null, null, 'created', { db: path.basename(dbFile), uploads: uploadsFile ? path.basename(uploadsFile) : null })
  return { db: dbFile, uploads: uploadsFile }
}

const DB_BACKUP_RE = /^carelane-\d{8}\.db$/

/**
 * List database (and matching uploads) backup snapshots, newest first.
 * @returns {Array<{db:string, uploads:string|null, size_bytes:number, created_at:string}>}
 */
export function listBackups () {
  if (!fs.existsSync(config.backupPath)) return []
  const files = fs.readdirSync(config.backupPath)
  return files
    .filter(f => DB_BACKUP_RE.test(f))
    .map(db => {
      const stamp = db.slice('carelane-'.length, 'carelane-'.length + 8)
      const uploads = `uploads-${stamp}.tar`
      const stat = fs.statSync(path.join(config.backupPath, db))
      return {
        db,
        uploads: files.includes(uploads) ? uploads : null,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString()
      }
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * Open a backup database read-only and run `PRAGMA integrity_check`, plus a
 * couple of sanity counts, so a snapshot can be trusted before relying on it.
 * @param {string} filename db backup filename (basename, within BACKUP_PATH)
 * @returns {{ ok:boolean, integrity:string, clients:number, shifts:number }}
 */
export function verifyBackup (filename) {
  if (!DB_BACKUP_RE.test(filename)) throw new Error('Not a recognised backup filename')
  const full = path.join(config.backupPath, path.basename(filename))
  if (!fs.existsSync(full)) throw new Error('Backup file not found')
  const db = new Database(full, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    const clients = db.prepare('SELECT COUNT(*) AS c FROM clients').get().c
    const shifts = db.prepare('SELECT COUNT(*) AS c FROM shift_notes').get().c
    return { ok: integrity === 'ok', integrity, clients, shifts }
  } finally {
    db.close()
  }
}

/**
 * Report on backup freshness for startup warnings and the admin UI.
 * @returns {{ enabled:boolean, latest:string|null, age_hours:number|null, stale:boolean, count:number }}
 */
export function backupFreshness () {
  const backups = listBackups()
  if (!config.backupEnabled) return { enabled: false, latest: null, age_hours: null, stale: false, count: backups.length }
  if (!backups.length) return { enabled: true, latest: null, age_hours: null, stale: true, count: 0 }
  const latest = backups[0]
  const ageHours = (Date.now() - new Date(latest.created_at).getTime()) / (60 * 60 * 1000)
  return {
    enabled: true,
    latest: latest.created_at,
    age_hours: Math.round(ageHours * 10) / 10,
    stale: ageHours > config.backupStaleHours,
    count: backups.length
  }
}

/**
 * Startup check: warn loudly (and record in the audit log) if backups are
 * enabled but missing or older than BACKUP_STALE_HOURS.
 */
export function warnIfBackupsStale () {
  const f = backupFreshness()
  if (!f.enabled || !f.stale) return
  const msg = f.count === 0
    ? 'No database backups found yet — the first nightly backup has not run.'
    : `Latest database backup is ${f.age_hours}h old (threshold ${config.backupStaleHours}h).`
  console.warn(`⚠️  BACKUP WARNING: ${msg}`)
  logActivity('backup', null, null, 'stale_warning', { age_hours: f.age_hours, count: f.count })
}

/** Delete backups older than BACKUP_RETENTION days. */
export function applyRetention () {
  const cutoff = Date.now() - config.backupRetention * 24 * 60 * 60 * 1000
  for (const file of fs.readdirSync(config.backupPath)) {
    if (!/^(carelane-\d{8}\.db|uploads-\d{8}\.tar)$/.test(file)) continue
    const full = path.join(config.backupPath, file)
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
  }
}

/**
 * Schedule the nightly backup (default 02:00 local time) via node-cron.
 */
export function scheduleBackups () {
  if (!config.backupEnabled) return
  const [hh, mm] = config.backupTime.split(':').map(Number)
  cron.schedule(`${mm || 0} ${hh || 2} * * *`, () => {
    runBackup().catch(err => {
      console.error('nightly backup failed:', err)
      logActivity('backup', null, null, 'failed', { error: err.message?.slice(0, 100) })
    })
  })
  console.log(`nightly backups scheduled at ${config.backupTime}, retention ${config.backupRetention} days`)
}
