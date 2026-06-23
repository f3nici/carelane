import config, { assertProductionSecrets } from './config.js'
import { migrate } from './db/migrate.js'
import { seed } from './db/seed.js'
import { assertEncryptionCanary } from './services/cryptoService.js'
import { checkEmbeddingModel } from './services/ragService.js'
import { scheduleBackups, warnIfBackupsStale } from './services/backupService.js'
import { scheduleMaterialisation } from './services/recurrenceService.js'
import { scheduleNotifications } from './services/ntfyService.js'
import { purgeExpired } from './services/loginThrottle.js'
import { logger } from './services/logger.js'
import { createApp } from './app.js'

assertProductionSecrets()
migrate()
seed()

// Refuse to start if ENCRYPTION_SECRET no longer matches existing ciphertext.
try {
  const { created } = assertEncryptionCanary()
  if (created) console.log('encryption canary sealed (first run)')
} catch (err) {
  console.error('Refusing to start:\n  - ' + err.message)
  process.exit(1)
}

// Warn (don't block) if the embedding model changed and a reindex is pending.
checkEmbeddingModel()

const app = createApp()

app.listen(config.port, () => {
  logger.info('CareLane listening', { port: config.port, env: config.nodeEnv, metrics: config.metricsEnabled })
  scheduleBackups()
  warnIfBackupsStale()
  scheduleMaterialisation()
  // Push proactive ntfy nudges (digest + shift reminders); no-op until configured.
  scheduleNotifications()
  // Sweep stale throttle/rate-limit rows hourly so the DB-backed buckets don't
  // accumulate. unref() so this timer never keeps the process alive on its own.
  purgeExpired()
  setInterval(purgeExpired, 60 * 60 * 1000).unref()
})
