import crypto from 'node:crypto'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { getSetting, updateSettings } from './settingsService.js'
import { getClient } from './clientService.js'
import { logActivity } from './activityService.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Square Invoicing. CareLane turns a completed shift note into a *draft* invoice
 * in the operator's Square account. The draft is never published/sent — the
 * operator reviews and sends it from Square. The Square access token is a secret
 * credential read from env (`SQUARE_ACCESS_TOKEN`, like the Anthropic key),
 * never stored in the database. Everything here is a no-op until a token is
 * present and the operator has enabled invoicing.
 *
 * Square's Invoices API supports only a single `primary_recipient`, so the
 * participant is set as that recipient (their email) and the plan-manager email
 * is surfaced on the draft as a custom field + description note for the operator
 * to CC manually before sending.
 */

// Pin the Square API version so responses stay stable as Square evolves.
const SQUARE_VERSION = '2025-05-21'
// Settings key gating whether the operator has turned invoicing on.
const ENABLED_KEY = 'square_invoicing_enabled'

/** Square REST host for the configured environment. */
function apiBase () {
  return config.squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'
}

/** True when a Square access token is configured in the environment. */
export function isConfigured () {
  return !!config.squareAccessToken
}

/** Pinned/auto-detected Square location id used for orders + invoices. */
function configuredLocationId () {
  return getSetting('square_location_id', config.squareLocationId || null)
}

/** Currency for money amounts (matches the Square location). */
function currency () {
  return getSetting('square_currency', 'AUD')
}

/**
 * Authenticated Square REST call. Returns the parsed JSON body, or throws an
 * Error whose message is the first Square error detail.
 * @param {string} path e.g. '/v2/locations'
 * @param {{method?:string, body?:object}} [opts]
 */
async function squareFetch (path, opts = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${config.squareAccessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
      Accept: 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  let json = {}
  try { json = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const first = json && Array.isArray(json.errors) ? json.errors[0] : null
    const err = new Error((first && (first.detail || first.code)) || `Square API returned ${res.status}`)
    err.status = res.status
    throw err
  }
  return json
}

/** Record the live error banner (mirrors what is also logged to the audit trail). */
function recordError (message) {
  updateSettings({ square_last_error: { at: new Date().toISOString(), error: String(message || 'unknown').slice(0, 200) } })
}

/** Dismiss the live error banner. The audit-log history is untouched. */
export function clearError () {
  updateSettings({ square_last_error: null })
  return status()
}

/** Number of draft invoices CareLane has created in Square. */
function invoiceCount () {
  const row = sqlite.prepare('SELECT COUNT(*) AS c FROM square_invoices').get()
  return row ? row.c : 0
}

/** Operator-facing status for the settings UI. */
export function status () {
  const configured = isConfigured()
  return {
    configured,
    enabled: !!getSetting(ENABLED_KEY, 0),
    environment: config.squareEnvironment,
    location_id: configuredLocationId(),
    location_name: getSetting('square_location_name', null),
    currency: currency(),
    last_invoice_at: getSetting('square_last_invoice_at', null),
    last_error: configured ? getSetting('square_last_error', null) : null,
    invoice_count: invoiceCount()
  }
}

/**
 * Live health check: confirm the access token can reach the account and resolve
 * a location to invoice against. Auto-detects (and stores) the location +
 * currency when none is pinned. Never throws.
 * @returns {Promise<{ok:boolean, location_name?:string, location_id?:string, currency?:string, environment?:string, error?:string}>}
 */
export async function testConnection () {
  if (!isConfigured()) return { ok: false, error: 'Square is not configured (set SQUARE_ACCESS_TOKEN)' }
  try {
    const data = await squareFetch('/v2/locations')
    const locations = data.locations || []
    const active = locations.filter(l => l.status === 'ACTIVE')
    const pinned = configuredLocationId()
    const loc = active.find(l => l.id === pinned) || active[0] || locations[0]
    if (!loc) return { ok: false, error: 'No Square locations found on this account' }
    updateSettings({
      square_location_id: loc.id,
      square_location_name: loc.name || null,
      square_currency: loc.currency || 'AUD',
      square_last_error: null
    })
    return {
      ok: true,
      location_name: loc.name || null,
      location_id: loc.id,
      currency: loc.currency || 'AUD',
      environment: config.squareEnvironment
    }
  } catch (err) {
    const message = String(err.message || err).slice(0, 160)
    recordError(message)
    return { ok: false, error: message }
  }
}

/** Human label for a billing-code unit, used in the line-item note. */
function unitLabel (unit) {
  return ({ H: 'hours', E: 'each', D: 'days', WK: 'weeks', MON: 'months' })[unit] || 'units'
}

/**
 * Resolve the single invoice line item for a shift: the per-client rate (custom
 * rate override, falling back to the code's standard price cap), the quantity
 * (hours for hourly codes, otherwise 1) and the resulting amount in minor units.
 * Pure + exported so it can be unit-tested without hitting Square.
 * @param {{duration_hours:number|null, shift_date:string}} shift
 * @param {{code:string, name:string, unit:string, price_cap_standard:number|null}} code
 * @param {number|null} customRate per-client rate override (or null)
 * @returns {{name:string, note:string, quantity:number, rate:number, amountCents:number}}
 */
export function resolveLineItem (shift, code, customRate) {
  const rate = customRate ?? code.price_cap_standard
  if (rate == null) throw new ApiError(422, 'NO_RATE', `No rate set for ${code.code} for this participant — add a rate under the participant's billing codes`)
  const hourly = code.unit === 'H'
  const quantity = hourly ? shift.duration_hours : 1
  if (hourly && !quantity) throw new ApiError(422, 'NO_DURATION', 'Shift note has no duration to bill')
  const amountCents = Math.round(rate * quantity * 100)
  if (amountCents <= 0) throw new ApiError(422, 'ZERO_AMOUNT', 'Computed invoice amount is zero')
  const note = `${quantity} ${unitLabel(code.unit)} @ $${rate}/${code.unit} · ${shift.shift_date}`
  return { name: `${code.code} — ${code.name}`, note, quantity, rate, amountCents }
}

/**
 * Ensure the participant exists as a Square customer (reused across invoices).
 * Looks up by stored id, then by email, then creates one — caching the id back
 * on the client row. Only the minimal fields needed to address an invoice are
 * sent to Square (name, email, phone).
 * @param {object} client decrypted client record
 * @returns {Promise<string>} Square customer id
 */
async function ensureCustomer (client) {
  const row = sqlite.prepare('SELECT square_customer_id FROM clients WHERE id = ?').get(client.id)
  if (row && row.square_customer_id) {
    // Verify the cached id still resolves — it can go stale if the account or
    // environment changed (Square ids are per-account/per-environment). On a
    // 404 we drop it and recreate; other errors are surfaced as-is.
    try {
      await squareFetch(`/v2/customers/${row.square_customer_id}`)
      return row.square_customer_id
    } catch (err) {
      if (err.status !== 404) throw err
      sqlite.prepare('UPDATE clients SET square_customer_id = NULL WHERE id = ?').run(client.id)
    }
  }

  let customerId = null
  if (client.email) {
    const search = await squareFetch('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { email_address: { exact: client.email } } }, limit: 1 }
    })
    customerId = search.customers && search.customers[0] ? search.customers[0].id : null
  }
  if (!customerId) {
    const created = await squareFetch('/v2/customers', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        given_name: client.first_name || undefined,
        family_name: client.last_name || undefined,
        email_address: client.email || undefined,
        phone_number: client.phone || undefined,
        reference_id: `carelane-client-${client.id}`,
        note: client.ndis_number ? `NDIS ${client.ndis_number}` : undefined
      }
    })
    customerId = created.customer.id
  }
  sqlite.prepare('UPDATE clients SET square_customer_id = ? WHERE id = ?').run(customerId, client.id)
  return customerId
}

/** Existing CareLane-tracked invoice for a shift note, if any. */
function existingInvoiceForShift (shiftNoteId) {
  return sqlite.prepare('SELECT * FROM square_invoices WHERE shift_note_id = ? ORDER BY id DESC LIMIT 1').get(shiftNoteId)
}

/**
 * Create a DRAFT invoice in Square from a single shift note. The draft is not
 * sent — the operator reviews and sends it from Square. The shift is marked
 * billed and a tracking row is stored. Throws ApiError on any precondition or
 * Square failure.
 * @param {number} shiftNoteId
 * @param {number} userId acting user (for the audit trail)
 */
export async function createDraftInvoiceFromShift (shiftNoteId, userId) {
  if (!isConfigured()) throw new ApiError(400, 'SQUARE_NOT_CONFIGURED', 'Square is not configured (set SQUARE_ACCESS_TOKEN)')
  if (!getSetting(ENABLED_KEY, 0)) throw new ApiError(400, 'SQUARE_DISABLED', 'Square invoicing is not enabled in Settings')

  const shift = sqlite.prepare('SELECT * FROM shift_notes WHERE id = ? AND deleted_at IS NULL').get(shiftNoteId)
  if (!shift) throw new ApiError(404, 'NOT_FOUND', 'Shift note not found')

  const prior = existingInvoiceForShift(shiftNoteId)
  if (prior && prior.status !== 'CANCELED') {
    throw new ApiError(409, 'ALREADY_INVOICED', `This shift already has a Square invoice (${prior.invoice_number || prior.square_invoice_id})`)
  }
  if (!shift.billing_code_id) throw new ApiError(422, 'NO_BILLING_CODE', 'Shift note has no billing code to invoice')

  const code = sqlite.prepare('SELECT * FROM billing_codes WHERE id = ?').get(shift.billing_code_id)
  if (!code) throw new ApiError(422, 'NO_BILLING_CODE', 'Billing code not found')
  const link = sqlite.prepare('SELECT custom_rate FROM client_billing_codes WHERE client_id = ? AND billing_code_id = ?')
    .get(shift.client_id, shift.billing_code_id)
  const line = resolveLineItem(shift, code, link ? link.custom_rate : null)

  const locationId = configuredLocationId()
  if (!locationId) throw new ApiError(422, 'NO_LOCATION', 'No Square location resolved — use Test connection in Settings first')

  const client = getClient(shift.client_id)
  const cur = currency()

  try {
    const customerId = await ensureCustomer(client)

    // 1. An order holds the line item(s); the invoice references it.
    const orderRes = await squareFetch('/v2/orders', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: locationId,
          customer_id: customerId,
          reference_id: `carelane-shift-${shiftNoteId}`,
          line_items: [{
            name: line.name,
            quantity: '1',
            base_price_money: { amount: line.amountCents, currency: cur },
            note: line.note
          }]
        }
      }
    })
    const orderId = orderRes.order.id

    // Plan-manager can't be a true CC on a Square invoice, and invoice custom
    // fields need a paid Square plan — so surface the plan manager in the (free)
    // description for the operator to action before sending.
    const planManager = [client.plan_manager_name, client.plan_manager_contact].filter(Boolean).join(' ')
    const description = planManager ? `Plan Manager: ${planManager}` : undefined

    // Payment term comes from the participant (defaulting to 45 days).
    const dueDays = client.invoice_due_days ?? 45
    const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // 3. Create the invoice as a DRAFT (no publish call → nothing is sent).
    const invRes = await squareFetch('/v2/invoices', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        invoice: {
          location_id: locationId,
          order_id: orderId,
          primary_recipient: { customer_id: customerId },
          delivery_method: 'EMAIL',
          payment_requests: [{ request_type: 'BALANCE', due_date: dueDate, automatic_payment_source: 'NONE' }],
          // Square requires this on create. Card is the AU-supported online method;
          // it's a draft, so the operator can change payment options in Square
          // before sending (e.g. add bank-transfer instructions).
          accepted_payment_methods: { card: true },
          description,
          sale_or_service_date: shift.shift_date
        }
      }
    })
    const invoice = invRes.invoice

    const ts = new Date().toISOString()
    const result = sqlite.prepare(`INSERT INTO square_invoices
      (client_id, shift_note_id, square_invoice_id, square_order_id, invoice_number, status, public_url, amount, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(shift.client_id, shiftNoteId, invoice.id, orderId, invoice.invoice_number || null,
        invoice.status || 'DRAFT', invoice.public_url || null, line.amountCents / 100, cur, ts, ts)

    sqlite.prepare('UPDATE shift_notes SET billed = 1, updated_at = ? WHERE id = ?').run(ts, shiftNoteId)
    updateSettings({ square_last_invoice_at: ts, square_last_error: null })
    logActivity('square_invoice', result.lastInsertRowid, userId, 'created', {
      shift_id: shiftNoteId, client_id: shift.client_id, amount: line.amountCents / 100
    })

    return { invoice: getInvoice(result.lastInsertRowid), square: { id: invoice.id, status: invoice.status, version: invoice.version } }
  } catch (err) {
    if (err instanceof ApiError) throw err
    const message = String(err.message || err).slice(0, 160)
    recordError(message)
    logActivity('square_invoice', null, userId, 'failed', { shift_id: shiftNoteId, error: message })
    throw new ApiError(502, 'SQUARE_ERROR', `Square invoice failed: ${message}`)
  }
}

/** Fetch one tracked invoice row by local id. */
export function getInvoice (id) {
  return sqlite.prepare('SELECT * FROM square_invoices WHERE id = ?').get(id) || null
}

/**
 * List tracked Square invoices, newest first, with optional client / shift
 * filters. Used by the shift page (to show an existing invoice) and any future
 * invoice list.
 * @param {{client_id?:string|number, shift_note_id?:string|number}} [filters]
 */
export function listInvoices (filters = {}) {
  const where = []
  const params = []
  if (filters.client_id) { where.push('client_id = ?'); params.push(Number(filters.client_id)) }
  if (filters.shift_note_id) { where.push('shift_note_id = ?'); params.push(Number(filters.shift_note_id)) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return sqlite.prepare(`SELECT * FROM square_invoices ${whereSql} ORDER BY id DESC`).all(...params)
}
