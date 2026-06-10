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
