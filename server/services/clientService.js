import { sqlite } from '../db/connection.js'
import { encrypt, decrypt, decryptFields, blindIndex } from './cryptoService.js'
import { ApiError } from '../middleware/errorHandler.js'

/** Snake_case column names that are encrypted at rest. */
const ENCRYPTED = ['first_name', 'last_name', 'ndis_number', 'date_of_birth', 'phone', 'email',
  'address', 'plan_manager_name', 'plan_manager_contact', 'emergency_contact_name',
  'emergency_contact_phone', 'notes']

const COLUMNS = ['first_name', 'last_name', 'preferred_name', 'ndis_number', 'date_of_birth',
  'phone', 'email', 'address', 'suburb', 'state', 'postcode', 'plan_start', 'plan_end',
  'plan_management_type', 'plan_manager_name', 'plan_manager_contact', 'primary_disability',
  'communication_needs', 'support_goals', 'emergency_contact_name', 'emergency_contact_phone',
  'notes', 'active']

const now = () => new Date().toISOString()

/**
 * Build a human-readable client name for list/dashboard rows. Prefers the
 * plaintext preferred_name, then the decrypted legal name, and only falls back
 * to a stable `Client #<id>` label when no name is stored. Accepts either a
 * client row or an aliased join row (e.g. `client_first_name`).
 * @param {object} row row carrying preferred_name/first_name/last_name (or the
 *   `client_`-prefixed aliases) plus an id/client_id
 * @returns {string}
 */
export function clientDisplayName (row = {}) {
  const preferred = (row.preferred_name ?? row.client_preferred_name)?.trim()
  if (preferred) return preferred
  const first = decrypt(row.first_name ?? row.client_first_name)
  const last = decrypt(row.last_name ?? row.client_last_name)
  const full = [first, last].map(v => v?.trim()).filter(Boolean).join(' ')
  if (full) return full
  const id = row.id ?? row.client_id
  return id ? `Client #${id}` : 'Client'
}

/** Decrypt a client row for an authorised response. */
function toClient (row) {
  if (!row) return null
  const { ndis_number_hash: _omit, ...rest } = decryptFields(row, ENCRYPTED)
  return rest
}

/**
 * List clients with pagination + search. Search matches non-encrypted minimal
 * fields (preferred_name, suburb, postcode) and the NDIS-number blind index.
 * @param {{page:number, perPage:number, offset:number}} pg
 * @param {{q?:string, active?:string}} filters
 */
export function listClients (pg, filters = {}) {
  const where = ['deleted_at IS NULL']
  const params = []
  if (filters.active === 'true') { where.push('active = 1') }
  if (filters.q) {
    const q = `%${filters.q}%`
    where.push('(preferred_name LIKE ? OR suburb LIKE ? OR postcode LIKE ? OR ndis_number_hash = ?)')
    params.push(q, q, q, blindIndex(filters.q))
  }
  const whereSql = 'WHERE ' + where.join(' AND ')
  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM clients ${whereSql}`).get(...params).c
  const rows = sqlite.prepare(`SELECT * FROM clients ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset)
  return { rows: rows.map(toClient), total }
}

/**
 * Fetch one client (decrypted) or throw 404.
 * @param {number} id
 */
export function getClient (id) {
  const row = sqlite.prepare('SELECT * FROM clients WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Client not found')
  return toClient(row)
}

/**
 * Create a client. PII fields are encrypted before insert; the NDIS number
 * also gets a blind index for exact-match search.
 * @param {object} data validated client payload (snake_case)
 */
export function createClient (data) {
  const ts = now()
  const values = {}
  for (const col of COLUMNS) {
    const v = data[col] ?? null
    values[col] = ENCRYPTED.includes(col) ? encrypt(v) : v
  }
  values.ndis_number_hash = blindIndex(data.ndis_number)
  const cols = [...COLUMNS, 'ndis_number_hash', 'created_at', 'updated_at']
  const stmt = sqlite.prepare(`INSERT INTO clients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
  const result = stmt.run(...COLUMNS.map(c => values[c]), values.ndis_number_hash, ts, ts)
  return getClient(result.lastInsertRowid)
}

/**
 * Update a client (full replace of validated fields).
 * @param {number} id
 * @param {object} data
 */
export function updateClient (id, data) {
  getClient(id)
  const sets = []
  const params = []
  for (const col of COLUMNS) {
    if (!(col in data)) continue
    sets.push(`${col} = ?`)
    params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
  }
  if ('ndis_number' in data) { sets.push('ndis_number_hash = ?'); params.push(blindIndex(data.ndis_number)) }
  sets.push('updated_at = ?')
  params.push(now(), id)
  sqlite.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getClient(id)
}

/**
 * Soft-delete a client (regulated record — never hard-deleted).
 * @param {number} id
 */
export function deleteClient (id) {
  getClient(id)
  sqlite.prepare('UPDATE clients SET deleted_at = ?, active = 0, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/**
 * Export all data held for a client (privacy/data-access request).
 * @param {number} id
 */
export function exportClient (id) {
  const client = getClient(id)
  const agreements = sqlite.prepare('SELECT * FROM service_agreements WHERE client_id = ? AND deleted_at IS NULL').all(id)
  const shifts = sqlite.prepare('SELECT * FROM shift_notes WHERE client_id = ? AND deleted_at IS NULL').all(id)
    .map(s => decryptFields(s, ['body', 'incident_details']))
  const reportRows = sqlite.prepare('SELECT * FROM reports WHERE client_id = ? AND deleted_at IS NULL').all(id)
  return { client, agreements, shifts, reports: reportRows, exported_at: now() }
}

/**
 * Billing codes linked to a client (with custom rate overrides).
 * @param {number} clientId
 */
export function getClientBillingCodes (clientId) {
  getClient(clientId)
  return sqlite.prepare(`SELECT cbc.id AS link_id, cbc.custom_rate, bc.*
    FROM client_billing_codes cbc JOIN billing_codes bc ON bc.id = cbc.billing_code_id
    WHERE cbc.client_id = ? ORDER BY bc.code`).all(clientId)
}

/**
 * Replace the set of billing codes linked to a client.
 * @param {number} clientId
 * @param {Array<{billing_code_id:number, custom_rate?:number}>} codes
 */
export function setClientBillingCodes (clientId, codes) {
  getClient(clientId)
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM client_billing_codes WHERE client_id = ?').run(clientId)
    const insert = sqlite.prepare('INSERT INTO client_billing_codes (client_id, billing_code_id, custom_rate, created_at) VALUES (?, ?, ?, ?)')
    for (const c of codes) insert.run(clientId, c.billing_code_id, c.custom_rate ?? null, now())
  })
  tx()
  return getClientBillingCodes(clientId)
}
