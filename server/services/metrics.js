import { sqlite } from '../db/connection.js'
import { logger } from './logger.js'

/**
 * Minimal in-process metrics registry exposing a Prometheus text-format
 * scrape at `/metrics` for self-hosters running monitoring. No external
 * dependency — counters/histograms are plain maps, app gauges are computed from
 * the database at scrape time (all cheap COUNT(*)s). Labels are deliberately
 * low-cardinality (HTTP method + status only — never the request path, which
 * carries record ids) so the series count stays bounded.
 */

const PREFIX = 'carelane_'
const startTime = Date.now()

// http_requests_total{method,status} -> count
const requestCounts = new Map()
// Latency histogram (seconds). Cumulative bucket counts + sum/count.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const durationBucketCounts = DURATION_BUCKETS.map(() => 0)
let durationSum = 0
let durationCount = 0

/**
 * Record one completed HTTP request.
 * @param {string} method
 * @param {number} status
 * @param {number} durationMs
 */
export function recordHttpRequest (method, status, durationMs) {
  const key = `${method}|${status}`
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1)
  const seconds = durationMs / 1000
  durationSum += seconds
  durationCount += 1
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]) durationBucketCounts[i] += 1
  }
}

/** Express middleware that times each request and feeds the registry. */
export function metricsMiddleware (req, res, next) {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    recordHttpRequest(req.method, res.statusCode, ms)
  })
  next()
}

/** Escape a Prometheus label value. */
function esc (v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Single COUNT(*) helper that degrades to null if the table is absent. */
function count (sql) {
  try { return sqlite.prepare(sql).get().c } catch { return null }
}

/**
 * Application gauges derived from the database. Kept small and resilient — a
 * missing table (e.g. sessions before the first request) yields a skipped
 * metric rather than a failed scrape.
 * @returns {Array<{ name:string, help:string, value:number }>}
 */
function appGauges () {
  const gauges = [
    { name: 'clients_total', help: 'Active (non-deleted) participant records', value: count('SELECT COUNT(*) AS c FROM clients WHERE deleted_at IS NULL') },
    { name: 'shift_notes_total', help: 'Active shift notes', value: count('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL') },
    { name: 'shift_notes_unfinalised', help: 'Shift notes not yet finalised', value: count('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND finalised = 0') },
    { name: 'incident_reports_open', help: 'Incident reports not yet closed', value: count("SELECT COUNT(*) AS c FROM incident_reports WHERE deleted_at IS NULL AND status != 'closed'") },
    { name: 'users_total', help: 'User accounts', value: count('SELECT COUNT(*) AS c FROM users') },
    { name: 'users_2fa_enabled', help: 'User accounts with TOTP enabled', value: count('SELECT COUNT(*) AS c FROM users WHERE totp_enabled = 1') },
    { name: 'audit_log_entries', help: 'Append-only audit log rows', value: count('SELECT COUNT(*) AS c FROM activity_log') },
    { name: 'active_sessions', help: 'Unexpired login sessions', value: count("SELECT COUNT(*) AS c FROM sessions WHERE datetime('now') < datetime(expire)") },
    { name: 'throttle_locked_keys', help: 'Login/rate-limit keys currently locked out', value: count(`SELECT COUNT(*) AS c FROM throttle_hits WHERE locked_until > ${Date.now()}`) }
  ]
  return gauges.filter(g => g.value !== null)
}

/**
 * Render the full registry in Prometheus text exposition format.
 * @returns {string}
 */
export function render () {
  const lines = []
  const mem = process.memoryUsage()

  lines.push(`# HELP ${PREFIX}up Whether the service is responding (always 1 when scraped).`)
  lines.push(`# TYPE ${PREFIX}up gauge`)
  lines.push(`${PREFIX}up 1`)

  lines.push(`# HELP ${PREFIX}process_uptime_seconds Seconds since the process started.`)
  lines.push(`# TYPE ${PREFIX}process_uptime_seconds gauge`)
  lines.push(`${PREFIX}process_uptime_seconds ${((Date.now() - startTime) / 1000).toFixed(0)}`)

  lines.push(`# HELP ${PREFIX}process_resident_memory_bytes Resident set size.`)
  lines.push(`# TYPE ${PREFIX}process_resident_memory_bytes gauge`)
  lines.push(`${PREFIX}process_resident_memory_bytes ${mem.rss}`)

  lines.push(`# HELP ${PREFIX}nodejs_heap_used_bytes V8 heap in use.`)
  lines.push(`# TYPE ${PREFIX}nodejs_heap_used_bytes gauge`)
  lines.push(`${PREFIX}nodejs_heap_used_bytes ${mem.heapUsed}`)

  lines.push(`# HELP ${PREFIX}http_requests_total Total HTTP requests by method and status.`)
  lines.push(`# TYPE ${PREFIX}http_requests_total counter`)
  for (const [key, value] of requestCounts) {
    const [method, status] = key.split('|')
    lines.push(`${PREFIX}http_requests_total{method="${esc(method)}",status="${esc(status)}"} ${value}`)
  }

  lines.push(`# HELP ${PREFIX}http_request_duration_seconds HTTP request latency.`)
  lines.push(`# TYPE ${PREFIX}http_request_duration_seconds histogram`)
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    lines.push(`${PREFIX}http_request_duration_seconds_bucket{le="${DURATION_BUCKETS[i]}"} ${durationBucketCounts[i]}`)
  }
  lines.push(`${PREFIX}http_request_duration_seconds_bucket{le="+Inf"} ${durationCount}`)
  lines.push(`${PREFIX}http_request_duration_seconds_sum ${durationSum}`)
  lines.push(`${PREFIX}http_request_duration_seconds_count ${durationCount}`)

  for (const g of appGauges()) {
    lines.push(`# HELP ${PREFIX}${g.name} ${g.help}.`)
    lines.push(`# TYPE ${PREFIX}${g.name} gauge`)
    lines.push(`${PREFIX}${g.name} ${g.value}`)
  }

  return lines.join('\n') + '\n'
}

/**
 * Express handler for `GET /metrics`. When `METRICS_TOKEN` is set, requires it
 * via `Authorization: Bearer <token>` or `?token=`; otherwise the endpoint is
 * open (intended for an internal-only scrape target, like `/healthz`).
 * @param {object} config app config
 */
export function metricsHandler (config) {
  return (req, res) => {
    if (config.metricsToken) {
      const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
      const provided = bearer || req.query.token
      if (provided !== config.metricsToken) {
        return res.status(401).type('text/plain').send('# unauthorized\n')
      }
    }
    try {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      res.send(render())
    } catch (err) {
      logger.error('metrics render failed', { err: err.message })
      res.status(500).type('text/plain').send('# metrics error\n')
    }
  }
}

/** Test helper: reset all in-memory counters. */
export function resetMetrics () {
  requestCounts.clear()
  durationBucketCounts.fill(0)
  durationSum = 0
  durationCount = 0
}
