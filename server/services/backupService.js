import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
