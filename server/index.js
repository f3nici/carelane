import config, { assertProductionSecrets } from './config.js'
import { migrate } from './db/migrate.js'
import { seed } from './db/seed.js'
import { assertEncryptionCanary } from './services/cryptoService.js'
import { checkEmbeddingModel } from './services/ragService.js'
import { scheduleBackups, warnIfBackupsStale } from './services/backupService.js'
import { scheduleMaterialisation } from './services/recurrenceService.js'
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
  console.log(`CareLane listening on :${config.port} (${config.nodeEnv})`)
  scheduleBackups()
  warnIfBackupsStale()
  scheduleMaterialisation()
})
