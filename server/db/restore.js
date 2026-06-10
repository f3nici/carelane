import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import config from '../config.js'
import { listBackups, verifyBackup } from '../services/backupService.js'

/**
 * Interactive restore CLI: `node server/db/restore.js [carelane-YYYYMMDD.db]`.
 *
 * Restoring is deliberately a manual, offline operation (never exposed over the
 * API): it overwrites the live database, so the server must be stopped first.
 * The current database is copied aside before anything is overwritten, and the
 * chosen snapshot is integrity-checked before it is trusted.
 */
async function main () {
  const arg = process.argv[2]
  const backups = listBackups()
  if (!backups.length) {
    console.error(`No backups found in ${config.backupPath}`)
    process.exit(1)
  }

  let target = arg
  if (!target) {
    console.log('Available backups (newest first):')
    backups.forEach((b, i) => console.log(`  [${i}] ${b.db}  (${(b.size_bytes / 1024 / 1024).toFixed(1)} MB, ${b.created_at})${b.uploads ? '  +uploads' : ''}`))
    target = backups[await prompt(`Select a backup [0-${backups.length - 1}]: `).then(Number) || 0]?.db
  }
  const chosen = backups.find(b => b.db === target)
  if (!chosen) {
    console.error(`Backup "${target}" not found.`)
    process.exit(1)
  }

  console.log(`\nVerifying ${chosen.db} …`)
  const check = verifyBackup(chosen.db)
  console.log(`  integrity: ${check.integrity}  ·  clients: ${check.clients}  ·  shifts: ${check.shifts}`)
  if (!check.ok) {
    console.error('Integrity check failed — refusing to restore from a corrupt snapshot.')
    process.exit(1)
  }

  const answer = await prompt(`\nThis OVERWRITES ${config.dbPath}. The server must be stopped. Continue? (yes/no) `)
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.')
    process.exit(0)
  }

  // Set the current DB aside (incl. WAL/SHM) before overwriting.
  if (fs.existsSync(config.dbPath)) {
    const aside = `${config.dbPath}.pre-restore-${Date.now()}`
    fs.copyFileSync(config.dbPath, aside)
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(config.dbPath + ext)) fs.rmSync(config.dbPath + ext)
    }
    console.log(`Current database copied to ${aside}`)
  }
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  fs.copyFileSync(path.join(config.backupPath, chosen.db), config.dbPath)
  console.log(`Restored database from ${chosen.db}`)

  if (chosen.uploads) {
    const restoreUploads = await prompt(`Also restore uploads from ${chosen.uploads}? (yes/no) `)
    if (restoreUploads.trim().toLowerCase() === 'yes') {
      const parent = path.dirname(path.resolve(config.uploadPath))
      execFileSync('tar', ['-xf', path.join(config.backupPath, chosen.uploads), '-C', parent])
      console.log('Uploads restored.')
    }
  }
  console.log('\nDone. Start the server with the original ENCRYPTION_SECRET so data decrypts.')
  process.exit(0)
}

/** Minimal stdin prompt. */
function prompt (question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer) }))
}

main().catch(err => { console.error(err); process.exit(1) })
