import config from '../config.js'

/**
 * Tiny dependency-free structured logger. Emits one JSON object per line
 * (`{ ts, level, msg, ...fields }`) when `LOG_FORMAT=json` — the shape
 * self-hosters' log shippers (Loki, Vector, CloudWatch, …) expect — and a
 * compact human-readable line otherwise (the default in development).
 *
 * Log lines are operational only: never pass participant PII or note bodies
 * here. The HTTP access logger records method + route + status + duration, never
 * query strings or bodies, to keep the same guarantee.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity }
const threshold = LEVELS[config.logLevel] ?? LEVELS.info
const asJson = config.logFormat === 'json'

/** Format and write a single log record at the given level. */
function emit (level, msg, fields) {
  if (LEVELS[level] < threshold) return
  const ts = new Date().toISOString()
  if (asJson) {
    let line
    try {
      line = JSON.stringify({ ts, level, msg, ...fields })
    } catch {
      // Circular/unserialisable fields must never crash a request — drop them.
      line = JSON.stringify({ ts, level, msg })
    }
    process.stdout.write(line + '\n')
    return
  }
  const extra = fields && Object.keys(fields).length ? ' ' + compact(fields) : ''
  const out = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`
  ;(level === 'error' ? process.stderr : process.stdout).write(out + '\n')
}

/** Render fields as `k=v` pairs for the pretty (non-JSON) formatter. */
function compact (fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
}

export const logger = {
  /** @param {string} msg @param {object} [fields] */
  debug: (msg, fields) => emit('debug', msg, fields),
  /** @param {string} msg @param {object} [fields] */
  info: (msg, fields) => emit('info', msg, fields),
  /** @param {string} msg @param {object} [fields] */
  warn: (msg, fields) => emit('warn', msg, fields),
  /** @param {string} msg @param {object} [fields] */
  error: (msg, fields) => emit('error', msg, fields)
}

export default logger
