import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'

const now = () => new Date().toISOString()

/**
 * List billing codes with search + active filter.
 * @param {{page:number, perPage:number, offset:number}} pg
 * @param {{q?:string, active?:string}} filters
 */
export function listBillingCodes (pg, filters = {}) {
  const where = ['1=1']
  const params = []
  if (filters.active === 'true') where.push('active = 1')
  if (filters.q) {
    where.push('(code LIKE ? OR name LIKE ? OR support_category LIKE ?)')
    const q = `%${filters.q}%`
    params.push(q, q, q)
  }
  const whereSql = 'WHERE ' + where.join(' AND ')
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM billing_codes ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT * FROM billing_codes ${whereSql} ORDER BY code LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset)
  return { rows, total }
}

/**
 * Fetch one billing code or throw 404.
 * @param {number} id
 */
export function getBillingCode (id) {
  const row = sqlite.prepare('SELECT * FROM billing_codes WHERE id = ?').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Billing code not found')
  return row
}

/**
 * Create a billing code manually.
 * @param {object} data validated payload
 */
export function createBillingCode (data) {
  const ts = now()
  const result = sqlite.prepare(`INSERT INTO billing_codes
    (code, name, support_category, registration_group, unit, price_cap_standard, price_cap_remote,
     price_cap_very_remote, quote_required, price_guide_version, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(data.code, data.name, data.support_category, data.registration_group, data.unit,
      data.price_cap_standard, data.price_cap_remote, data.price_cap_very_remote,
      data.quote_required, data.price_guide_version, data.active, ts, ts)
  return getBillingCode(result.lastInsertRowid)
}

/**
 * Update a billing code.
 * @param {number} id
 * @param {object} data
 */
export function updateBillingCode (id, data) {
  getBillingCode(id)
  const cols = ['code', 'name', 'support_category', 'registration_group', 'unit',
    'price_cap_standard', 'price_cap_remote', 'price_cap_very_remote', 'quote_required',
    'price_guide_version', 'active']
  const sets = []
  const params = []
  for (const c of cols) {
    if (!(c in data)) continue
    sets.push(`${c} = ?`)
    params.push(data[c] ?? null)
  }
  sets.push('updated_at = ?')
  params.push(now(), id)
  sqlite.prepare(`UPDATE billing_codes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getBillingCode(id)
}

/**
 * Deactivate a billing code (history must be kept for past claims — never
 * hard-deleted).
 * @param {number} id
 */
export function deactivateBillingCode (id) {
  getBillingCode(id)
  sqlite.prepare('UPDATE billing_codes SET active = 0, updated_at = ? WHERE id = ?').run(now(), id)
}

/**
 * Commit a reviewed price-guide import. Matches on `code`: updates caps on
 * existing items, inserts new ones, and optionally deactivates items absent
 * from the new guide.
 * @param {{price_guide_version:string, rows:Array, deactivate_missing:number}} payload
 * @returns {{inserted:number, updated:number, deactivated:number}}
 */
export function commitImport (payload) {
  const ts = now()
  const stats = { inserted: 0, updated: 0, deactivated: 0 }
  const seen = new Set()
  const tx = sqlite.transaction(() => {
    const find = sqlite.prepare('SELECT id FROM billing_codes WHERE code = ?')
    const update = sqlite.prepare(`UPDATE billing_codes SET name = ?, support_category = COALESCE(?, support_category),
      registration_group = COALESCE(?, registration_group), unit = ?, price_cap_standard = ?, price_cap_remote = ?,
      price_cap_very_remote = ?, quote_required = ?, price_guide_version = ?, active = 1, updated_at = ? WHERE id = ?`)
    const insert = sqlite.prepare(`INSERT INTO billing_codes
      (code, name, support_category, registration_group, unit, price_cap_standard, price_cap_remote,
       price_cap_very_remote, quote_required, price_guide_version, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    for (const r of payload.rows) {
      seen.add(r.code)
      const existing = find.get(r.code)
      if (existing) {
        update.run(r.name, r.support_category, r.registration_group, r.unit, r.price_cap_standard,
          r.price_cap_remote, r.price_cap_very_remote, r.quote_required, payload.price_guide_version, ts, existing.id)
        stats.updated++
      } else {
        insert.run(r.code, r.name, r.support_category, r.registration_group, r.unit, r.price_cap_standard,
          r.price_cap_remote, r.price_cap_very_remote, r.quote_required, payload.price_guide_version, ts, ts)
        stats.inserted++
      }
    }
    if (payload.deactivate_missing) {
      const active = sqlite.prepare('SELECT id, code FROM billing_codes WHERE active = 1').all()
      const deactivate = sqlite.prepare('UPDATE billing_codes SET active = 0, updated_at = ? WHERE id = ?')
      for (const row of active) {
        if (!seen.has(row.code)) { deactivate.run(ts, row.id); stats.deactivated++ }
      }
    }
  })
  tx()
  return stats
}
