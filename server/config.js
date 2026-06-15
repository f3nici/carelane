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
  embeddingModel: env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5',
  // bge-style retrieval models expect a short instruction prefixed to the
  // *query* (not the stored passages). Auto-applied for bge models unless an
  // explicit prefix (possibly empty) is given. Other models default to none.
  embeddingQueryPrefix: env.EMBEDDING_QUERY_PREFIX ??
    ((env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5').includes('bge')
      ? 'Represent this sentence for searching relevant passages: '
      : ''),
  // Hybrid search: pull this many candidates from each of the vector + keyword
  // (BM25) arms before fusing with Reciprocal Rank Fusion and reranking.
  searchCandidatePool: parseInt(env.SEARCH_CANDIDATE_POOL || '40', 10),
  // Local cross-encoder reranker (transformers.js). Reorders the fused
  // candidates for a large precision gain. Degrades gracefully if the model
  // cannot load (e.g. offline first run) — results fall back to the fused order.
  rerankEnabled: (env.RERANK_ENABLED || 'true') === 'true',
  rerankerModel: env.RERANKER_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2',
  defaultPriceRegion: env.DEFAULT_PRICE_REGION || 'standard',
  backupEnabled: (env.BACKUP_ENABLED || 'true') === 'true',
  backupPath: env.BACKUP_PATH || './data/backups',
  backupRetention: parseInt(env.BACKUP_RETENTION || '14', 10),
  backupTime: env.BACKUP_TIME || '02:00',
  backupStaleHours: parseInt(env.BACKUP_STALE_HOURS || '48', 10),
  loginMaxAttempts: parseInt(env.LOGIN_MAX_ATTEMPTS || '5', 10),
  loginWindowMinutes: parseInt(env.LOGIN_WINDOW_MINUTES || '15', 10),
  publicApiEnabled: (env.PUBLIC_API_ENABLED || 'false') === 'true',
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),
  // Google Calendar one-way push (optional). App credentials live in env; the
  // per-user refresh token is stored encrypted in settings (see
  // googleCalendarService). Sync is a no-op until both are present.
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: env.GOOGLE_REDIRECT_URI || 'http://localhost:3778/api/v1/schedule/google/callback',
  // Square Invoicing (optional). The access token is a secret credential
  // (a Personal Access Token from the Square Developer Dashboard) and lives in
  // env — like ANTHROPIC_API_KEY, never stored in the database. The environment
  // selects which Square API host to call; the location is auto-detected on the
  // first "Test connection" but can be pinned here. Invoicing is a no-op until a
  // token is present and the operator enables it. See squareService.
  squareAccessToken: env.SQUARE_ACCESS_TOKEN || '',
  squareEnvironment: env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  squareLocationId: env.SQUARE_LOCATION_ID || ''
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
