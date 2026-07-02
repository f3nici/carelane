// Field names whose values are likely to carry PII or sensitive health
// information. Only the field *name* is ever kept for these — the value is
// redacted before it touches the append-only log (see CLAUDE.md hard rules:
// all data is sensitive health information and the audit trail is PII-redacted).
const PII_KEYS = /name|phone|email|address|dob|birth|ndis|notes|body|incident|contact|manager|disability|goal|communication|summary|markdown|questionnaire|participant|location|support_provided/i

// Genesis link for the very first entry in the tamper-evident hash chain.
const GENESIS_HASH = '0'.repeat(64)

/**
 * Redact a single scalar value based on its field name. PII/health field names
 * collapse to a marker; long free text is truncated; everything else passes
 * through so safe fields (status, dates, flags…) stay readable for auditing.
 * @param {string} key
 * @param {*} value
 */
function redactScalar (key, value) {
  if (value === null || value === undefined) return value
  if (PII_KEYS.test(key)) return '[redacted]'
  if (typeof value === 'string' && value.length > 120) return '[truncated]'
  if (value && typeof value === 'object') return '[updated]'
  return value
}

/**
 * Redact likely-PII values from an activity details object. Field names and
 * safe scalar values are kept. A `changes` array (field-level before/after
 * diff) is redacted per-field using the field name, so the audit log records
 * *what* changed without leaking the sensitive values themselves.
 * @param {object} details
 */
function redact (details) {
  if (!details || typeof details !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(details)) {
    if (k === 'changes' && Array.isArray(v)) {
      out.changes = v.map(c => ({
        field: c.field,
        from: redactScalar(c.field, c.from),
        to: redactScalar(c.field, c.to)
      }))
    } else {
      out[k] = redactScalar(k, v)
    }
  }
  return out
}

/**
 * Reduce a value to a loggable scalar — objects/arrays become an `[updated]`
 * marker rather than being dumped (they may hold PII and add noise).
 * @param {*} v
 */
function scalarOf (v) {
  return (v && typeof v === 'object') ? '[updated]' : (v ?? null)
}

/**
 * Compare two field values for equality, treating null/undefined as equal and
 * comparing objects/arrays structurally.
 * @param {*} a
 * @param {*} b
 */
function sameValue (a, b) {
  if (a === b) return true
  if (a == null && b == null) return true
  if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return String(a) === String(b)
}

/**
 * Build a field-level change set (before → after) for the given fields. Only
 * fields whose value actually changed are returned. Values are scalarised here;
 * PII redaction happens later in `logActivity`. Pure — exported standalone so
 * routes can build a diff before logging.
 * @param {object} before record state before the update (decrypted where needed)
 * @param {object} after record state after the update
 * @param {string[]} fields field names to inspect (typically the submitted keys)
 * @returns {Array<{field:string, from:*, to:*}>}
 */
export function diffChanges (before = {}, after = {}, fields = []) {
  const changes = []
  for (const f of fields) {
    if (f === 'id') continue
    const a = before?.[f] ?? null
    const b = after?.[f] ?? null
    if (!sameValue(a, b)) changes.push({ field: f, from: scalarOf(a), to: scalarOf(b) })
  }
  return changes
}

/**
 * Build the append-only, tamper-evident audit service bound to a host context.
 * Both hosts need the hash chain, so this lives in core; only the injected
 * `crypto.createHash` (SHA-256) and `sqlite` differ per host.
 * @param {import('./index.js').CoreContext} ctx
 */
export function createActivityService (ctx) {
  const { sqlite, crypto } = ctx
  const now = () => new Date(ctx.now()).toISOString()

  /**
   * Compute the SHA-256 hash for an audit-log entry, chained off the previous
   * entry's hash. Any silent edit, deletion or reordering breaks the chain.
   * @param {{entity_type:string, entity_id:*, user_id:*, action:string, details:*, created_at:string}} entry
   * @param {string} prevHash
   * @returns {string} hex digest
   */
  function computeEntryHash (entry, prevHash) {
    const payload = [
      prevHash,
      entry.entity_type,
      entry.entity_id ?? '',
      entry.user_id ?? '',
      entry.action,
      entry.details ?? '',
      entry.created_at
    ].join('|')
    return crypto.createHash('sha256').update(payload).digest('hex')
  }

  // Append one entry atomically: read the chain tail and insert in a single
  // transaction so concurrent writes can never fork the hash chain. Runs as
  // BEGIN IMMEDIATE so the tail read takes the database write lock up front —
  // this also guards against a *second process* (e.g. a CLI script run while the
  // server is up) reading the same tail and forking the chain.
  const appendEntry = sqlite.transaction((entry) => {
    const last = sqlite.prepare(
      'SELECT hash FROM activity_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get()
    const prevHash = last?.hash || GENESIS_HASH
    const hash = computeEntryHash(entry, prevHash)
    sqlite.prepare(`INSERT INTO activity_log
        (entity_type, entity_id, user_id, action, details, created_at, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.entity_type, entry.entity_id, entry.user_id, entry.action, entry.details,
        entry.created_at, prevHash, hash)
  }).immediate

  /**
   * Append an entry to the append-only audit log. PII is redacted from details
   * and each row is sealed into a tamper-evident SHA-256 hash chain.
   * @param {string} entityType client / agreement / shift / report / document / billing_code / settings / backup / auth
   * @param {number|null} entityId
   * @param {number|null} userId
   * @param {string} action created / updated / status_changed / ai_drafted / finalised / deleted / restored ...
   * @param {object} [details]
   */
  function logActivity (entityType, entityId, userId, action, details = {}) {
    appendEntry({
      entity_type: entityType,
      entity_id: entityId ?? null,
      user_id: userId ?? null,
      action,
      details: JSON.stringify(redact(details)),
      created_at: now()
    })
  }

  /**
   * Backfill hash-chain columns for legacy rows written before chaining existed.
   * The append-only UPDATE trigger is dropped for the duration of the rewrite and
   * recreated immediately after, all inside one transaction. Idempotent: a no-op
   * once every row carries a hash.
   * @returns {number} number of rows backfilled
   */
  function backfillAuditHashes () {
    const pending = sqlite.prepare('SELECT * FROM activity_log WHERE hash IS NULL ORDER BY id ASC').all()
    if (!pending.length) return 0
    const tx = sqlite.transaction(() => {
      sqlite.exec('DROP TRIGGER IF EXISTS activity_log_no_update')
      let prevHash = sqlite.prepare('SELECT hash FROM activity_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.hash || GENESIS_HASH
      const upd = sqlite.prepare('UPDATE activity_log SET prev_hash = ?, hash = ? WHERE id = ?')
      for (const row of pending) {
        const hash = computeEntryHash(row, prevHash)
        upd.run(prevHash, hash, row.id)
        prevHash = hash
      }
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS activity_log_no_update
        BEFORE UPDATE ON activity_log
        BEGIN
          SELECT RAISE(ABORT, 'activity_log is append-only');
        END;`)
    })
    tx()
    return pending.length
  }

  /**
   * Verify the integrity of the entire audit-log hash chain. Walks every row in
   * insertion order, recomputing each hash and confirming it links to the prior
   * entry. Detects silent edits, deletions or reordering.
   * @returns {{ valid:boolean, total:number, verified:number, broken_at:number|null, broken_at_date?:string }}
   */
  function verifyAuditChain () {
    const rows = sqlite.prepare(`SELECT id, entity_type, entity_id, user_id, action, details, created_at, prev_hash, hash
      FROM activity_log ORDER BY id ASC`).all()
    let prevHash = GENESIS_HASH
    let verified = 0
    for (const row of rows) {
      // Rows predating the chain (un-backfilled) carry no hash; skip them but keep
      // the running prevHash so later rows still validate.
      if (!row.hash) continue
      const expected = computeEntryHash(row, prevHash)
      if (row.prev_hash !== prevHash || row.hash !== expected) {
        return { valid: false, total: rows.length, verified, broken_at: row.id, broken_at_date: row.created_at }
      }
      prevHash = row.hash
      verified++
    }
    return { valid: true, total: rows.length, verified, broken_at: null }
  }

  /**
   * Most recent activity entries with the acting user's display name.
   * @param {number} [limit]
   */
  function recentActivity (limit = 25) {
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
  function queryActivity (filters = {}, pg = { perPage: 50, offset: 0 }) {
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
  function activityFacets () {
    const entityTypes = sqlite.prepare('SELECT DISTINCT entity_type FROM activity_log ORDER BY entity_type').all().map(r => r.entity_type)
    const actions = sqlite.prepare('SELECT DISTINCT action FROM activity_log ORDER BY action').all().map(r => r.action)
    return { entity_types: entityTypes, actions }
  }

  return {
    diffChanges,
    computeEntryHash,
    logActivity,
    backfillAuditHashes,
    verifyAuditChain,
    recentActivity,
    queryActivity,
    activityFacets
  }
}
