/**
 * Central application configuration loaded from environment variables.
 * Refuses to start in production with unset/default secrets.
 */
const env = process.env

const DEFAULT_MAX_UPLOAD = 10 * 1024 * 1024

const config = {
  port: parseInt(env.PORT || '3778', 10),
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',
  sessionSecret: env.SESSION_SECRET || 'change-me',
  encryptionSecret: env.ENCRYPTION_SECRET || 'change-me',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  // Default Claude model ids. These seed the operator-editable `claude_model_*`
  // settings (changed in-app under Settings → AI, so models can be upgraded
  // without redeploying); they are not read from env.
  claudeModelCheap: 'claude-haiku-4-5-20251001',
  claudeModelQuality: 'claude-sonnet-4-6',
  defaultUsername: env.DEFAULT_USERNAME || 'admin',
  defaultPassword: env.DEFAULT_PASSWORD || 'changeme',
  dbPath: env.DB_PATH || './data/carelane.db',
  uploadPath: env.UPLOAD_PATH || './uploads',
  maxUploadSize: parseInt(env.MAX_UPLOAD_SIZE || String(DEFAULT_MAX_UPLOAD), 10),
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
  // Where transformers.js caches the downloaded embedding/reranker models. It
  // defaults inside node_modules, which the non-root container user cannot write
  // to; point it under the (writable, bind-mounted) data dir instead so the
  // cache also persists across restarts rather than re-downloading each deploy.
  modelCachePath: env.MODEL_CACHE_PATH || './data/models',
  defaultPriceRegion: env.DEFAULT_PRICE_REGION || 'standard',
  backupEnabled: (env.BACKUP_ENABLED || 'true') === 'true',
  backupPath: env.BACKUP_PATH || './data/backups',
  backupRetention: parseInt(env.BACKUP_RETENTION || '14', 10),
  backupTime: env.BACKUP_TIME || '02:00',
  backupStaleHours: parseInt(env.BACKUP_STALE_HOURS || '48', 10),
  loginMaxAttempts: parseInt(env.LOGIN_MAX_ATTEMPTS || '5', 10),
  loginWindowMinutes: parseInt(env.LOGIN_WINDOW_MINUTES || '15', 10),
  // Structured logging. LOG_FORMAT=json emits one JSON object per line (for log
  // shippers); anything else is a human-readable line (the dev default). Levels:
  // debug < info < warn < error.
  logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  logFormat: env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  // Prometheus metrics at /metrics (for self-hosters running monitoring).
  // Disabled by default. When METRICS_TOKEN is set a Bearer token (or ?token=) is
  // required; with no token set, token-less scrapes are served only to a
  // private/loopback source address (a public source gets 401). Intended for an
  // internal-only scrape target, like /healthz.
  metricsEnabled: (env.METRICS_ENABLED || 'false') === 'true',
  metricsToken: env.METRICS_TOKEN || '',
  // Passkeys / WebAuthn (passwordless login). The relying-party id must be the
  // registrable domain the app is served from (e.g. carelane.example.org) and
  // the expected origin its full URL. Both are auto-derived from the incoming
  // request's Origin/Host when left blank, which is correct for a same-origin
  // deployment; pin them here when running behind a proxy that rewrites Host.
  webauthnRpId: env.WEBAUTHN_RP_ID || '',
  webauthnOrigin: env.WEBAUTHN_ORIGIN || '',
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
  // selects which Square API host to call. The location is auto-detected and
  // stored on the first "Test connection" in Settings (no env var needed).
  // Invoicing is a no-op until a token is present and the operator enables it.
  // See squareService.
  squareAccessToken: env.SQUARE_ACCESS_TOKEN || '',
  squareEnvironment: env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  // ntfy push notifications (optional). The server URL, topic, request timeout
  // and all timings / toggles are operator-editable in Settings (see
  // ntfyService); only the secret access token (for protected/self-hosted
  // servers) lives in env.
  ntfyToken: env.NTFY_TOKEN || '',
  // Public base URL of this CareLane install (e.g. https://carelane.example.org).
  // When set, push notifications carry a deep link back to the relevant page.
  appBaseUrl: (env.APP_BASE_URL || '').replace(/\/+$/, ''),
  // Public demo mode. When on, the app boots a self-contained demo: two shared
  // logins (a `demo` admin and a `demoworker` support worker, both password
  // `demo`), a rich set of fabricated example data, and a scheduled wipe-and-
  // reseed so any visitor's changes are rolled back on a fixed cadence. Account-
  // security and user-management writes are blocked so a visitor cannot lock
  // others out (change a password / 2FA / passkey, or deactivate the login).
  // NEVER enable this on an install holding real participant data — a reset
  // hard-deletes everything. See demoService.
  demoMode: (env.DEMO_MODE || 'false') === 'true',
  // How often (hours) the demo data is reset to its pristine state. Also runs
  // once at boot. Ignored unless demoMode is on.
  demoResetHours: parseInt(env.DEMO_RESET_HOURS || '6', 10)
}

/**
 * Effective per-route upload size limit. Some routes (knowledge PDFs, client
 * documents) legitimately need more headroom than the global default, but a
 * deliberately *lowered* MAX_UPLOAD_SIZE (e.g. to constrain a small host) must
 * still be honoured everywhere. So: if the operator lowered the global limit
 * below the default, that wins; otherwise the route's larger preferred cap
 * applies.
 * @param {number} preferred the route's preferred maximum in bytes
 * @returns {number}
 */
config.uploadLimitFor = preferred =>
  config.maxUploadSize < DEFAULT_MAX_UPLOAD ? config.maxUploadSize : Math.max(config.maxUploadSize, preferred)

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
  if (!env.DEFAULT_PASSWORD || env.DEFAULT_PASSWORD === 'changeme') {
    problems.push('DEFAULT_PASSWORD is unset or left at the insecure default (set it to a strong value before first run, or rotate the admin password)')
  }
  if (problems.length) {
    console.error('Refusing to start in production:\n  - ' + problems.join('\n  - '))
    process.exit(1)
  }
  // Non-fatal: when the relying-party id/origin are not pinned, passkey
  // verification trusts the request's Origin/Host headers. That is correct for a
  // plain same-origin deployment but weakens WebAuthn's origin binding behind a
  // proxy that can rewrite Host. Warn so operators pin them where appropriate.
  if (!env.WEBAUTHN_RP_ID || !env.WEBAUTHN_ORIGIN) {
    console.warn('WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN are not pinned — passkey origin is derived from request headers. Set both if the app runs behind a Host-rewriting proxy.')
  }
}

export default config
