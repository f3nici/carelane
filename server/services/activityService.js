import { sqlite } from '../db/connection.js'

const PII_KEYS = /name|phone|email|address|dob|birth|ndis|notes|body|incident|contact|manager/i

/**
 * Redact likely-PII values from an activity details object. Only field names
 * and safe scalar values are kept.
 * @param {object} details
 */
function redact (details) {
  if (!details || typeof details !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(details)) {
    if (PII_KEYS.test(k)) out[k] = '[redacted]'
    else if (typeof v === 'string' && v.length > 120) out[k] = '[truncated]'
    else out[k] = v
  }
  return out
}

/**
 * Append an entry to the append-only audit log. PII is redacted from details.
 * @param {string} entityType client / agreement / shift / report / document / billing_code / settings / backup / auth
 * @param {number|null} entityId
 * @param {number|null} userId
 * @param {string} action created / updated / status_changed / ai_drafted / finalised / deleted ...
 * @param {object} [details]
 */
export function logActivity (entityType, entityId, userId, action, details = {}) {
  sqlite.prepare(`INSERT INTO activity_log (entity_type, entity_id, user_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(entityType, entityId, userId, action, JSON.stringify(redact(details)), new Date().toISOString())
}

/**
 * Most recent activity entries with the acting user's display name.
 * @param {number} [limit]
 */
export function recentActivity (limit = 25) {
  return sqlite.prepare(`SELECT a.*, u.display_name AS user_name
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`).all(limit)
}

/**
 * Filterable, paginated view over the append-only audit log (for the auditor
 * UI). All values are already PII-redacted at write time.
 * @param {{entity_type?:string, entity_id?:number, action?:string, user_id?:number, from?:string, to?:string}} filters
 * @param {{perPage:number, offset:number}} pg
 * @returns {{ rows: object[], total: number }}
 */
export function queryActivity (filters = {}, pg = { perPage: 50, offset: 0 }) {
  const where = []
  const params = []
  if (filters.entity_type) { where.push('a.entity_type = ?'); params.push(filters.entity_type) }
  if (filters.entity_id) { where.push('a.entity_id = ?'); params.push(filters.entity_id) }
  if (filters.action) { where.push('a.action = ?'); params.push(filters.action) }
  if (filters.user_id) { where.push('a.user_id = ?'); params.push(filters.user_id) }
  if (filters.from) { where.push('a.created_at >= ?'); params.push(filters.from) }
  if (filters.to) { where.push('a.created_at <= ?'); params.push(filters.to + 'T23:59:59.999Z') }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM activity_log a ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT a.*, u.display_name AS user_name
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, pg.perPage, pg.offset)
  return { rows, total }
}

/**
 * Distinct entity types and actions present in the log, for filter dropdowns.
 * @returns {{ entity_types: string[], actions: string[] }}
 */
export function activityFacets () {
  const entityTypes = sqlite.prepare('SELECT DISTINCT entity_type FROM activity_log ORDER BY entity_type').all().map(r => r.entity_type)
  const actions = sqlite.prepare('SELECT DISTINCT action FROM activity_log ORDER BY action').all().map(r => r.action)
  return { entity_types: entityTypes, actions }
}
