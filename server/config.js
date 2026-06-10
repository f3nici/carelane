/**
 * Central application configuration loaded from environment variables.
 * Refuses to start in production with unset/default secrets.
 */
const env = process.env

const config = {
  port: parseInt(env.PORT || '3778', 10),
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',
  sessionSecret: env.SESSION_SECRET || 'change-me',
  encryptionSecret: env.ENCRYPTION_SECRET || 'change-me',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  claudeModelCheap: env.CLAUDE_MODEL_CHEAP || 'claude-haiku-4-5-20251001',
  claudeModelQuality: env.CLAUDE_MODEL_QUALITY || 'claude-sonnet-4-6',
  defaultUsername: env.DEFAULT_USERNAME || 'admin',
  defaultPassword: env.DEFAULT_PASSWORD || 'changeme',
  dbPath: env.DB_PATH || './data/carelane.db',
  uploadPath: env.UPLOAD_PATH || './uploads',
  maxUploadSize: parseInt(env.MAX_UPLOAD_SIZE || '10485760', 10),
  embeddingModel: env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  defaultPriceRegion: env.DEFAULT_PRICE_REGION || 'standard',
  backupEnabled: (env.BACKUP_ENABLED || 'true') === 'true',
  backupPath: env.BACKUP_PATH || './data/backups',
  backupRetention: parseInt(env.BACKUP_RETENTION || '14', 10),
  backupTime: env.BACKUP_TIME || '02:00',
  backupStaleHours: parseInt(env.BACKUP_STALE_HOURS || '48', 10),
  loginMaxAttempts: parseInt(env.LOGIN_MAX_ATTEMPTS || '5', 10),
  loginWindowMinutes: parseInt(env.LOGIN_WINDOW_MINUTES || '15', 10),
  publicApiEnabled: (env.PUBLIC_API_ENABLED || 'false') === 'true',
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim())
}

/**
 * Validate production-critical secrets. Exits the process when secrets are
 * missing or left at their insecure defaults in production.
 */
export function assertProductionSecrets () {
  if (!config.isProduction) return
  const problems = []
  if (!env.SESSION_SECRET || env.SESSION_SECRET === 'change-me') {
    problems.push('SESSION_SECRET is unset or left at default')
  }
  if (!env.ENCRYPTION_SECRET || env.ENCRYPTION_SECRET === 'change-me') {
    problems.push('ENCRYPTION_SECRET is unset or left at default')
  }
  if (problems.length) {
    console.error('Refusing to start in production:\n  - ' + problems.join('\n  - '))
    process.exit(1)
  }
}

export default config
