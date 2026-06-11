import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'
import { clientDisplayName, restoreClient } from './clientService.js'
import { restoreAgreement } from './agreementService.js'
import { restoreShift } from './shiftService.js'
import { restoreReport } from './reportService.js'
import { restoreTemplate } from './templateService.js'
import { reactivateBillingCode } from './billingService.js'

/**
 * Build a single "deleted item" descriptor for the recycle-bin view. Labels are
 * operator-facing (this view is auth-gated, like the live lists) so participant
 * names may be shown — none of this is written back to the PII-redacted log.
 * @param {object} fields
 * @returns {{entity_type:string, id:number, label:string, sub_label:string|null, removed_at:string|null, kind:string}}
 */
function item ({ entity_type, id, label, sub_label = null, removed_at, kind = 'deleted' }) {
  return { entity_type, id, label, sub_label, removed_at, kind }
}

/**
 * List everything currently soft-deleted (clients, agreements, shift notes,
 * reports, templates) plus deactivated billing codes, newest removal first.
 * @returns {object[]}
 */
export function listDeleted () {
  const out = []

  for (const r of sqlite.prepare('SELECT * FROM clients WHERE deleted_at IS NOT NULL').all()) {
    out.push(item({ entity_type: 'client', id: r.id, label: clientDisplayName(r), sub_label: r.suburb || null, removed_at: r.deleted_at }))
  }

  for (const r of sqlite.prepare(`SELECT a.id, a.title, a.status, a.deleted_at, a.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM service_agreements a JOIN clients c ON c.id = a.client_id WHERE a.deleted_at IS NOT NULL`).all()) {
    out.push(item({ entity_type: 'agreement', id: r.id, label: r.title, sub_label: clientDisplayName(r), removed_at: r.deleted_at }))
  }

  for (const r of sqlite.prepare(`SELECT s.id, s.shift_date, s.duration_hours, s.deleted_at, s.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM shift_notes s JOIN clients c ON c.id = s.client_id WHERE s.deleted_at IS NOT NULL`).all()) {
    const dur = r.duration_hours ? ` · ${r.duration_hours}h` : ''
    out.push(item({ entity_type: 'shift', id: r.id, label: `Shift ${r.shift_date}${dur}`, sub_label: clientDisplayName(r), removed_at: r.deleted_at }))
  }

  for (const r of sqlite.prepare(`SELECT rp.id, rp.report_type, rp.period_start, rp.period_end, rp.deleted_at, rp.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM reports rp JOIN clients c ON c.id = rp.client_id WHERE rp.deleted_at IS NOT NULL`).all()) {
    const period = r.period_start ? ` (${r.period_start} → ${r.period_end || '—'})` : ''
    out.push(item({ entity_type: 'report', id: r.id, label: `${String(r.report_type).replace('_', ' ')} report${period}`, sub_label: clientDisplayName(r), removed_at: r.deleted_at }))
  }

  for (const r of sqlite.prepare('SELECT id, name, template_type, deleted_at FROM templates WHERE deleted_at IS NOT NULL').all()) {
    out.push(item({ entity_type: 'template', id: r.id, label: r.name, sub_label: r.template_type, removed_at: r.deleted_at }))
  }

  // Billing codes are deactivated (history kept), not soft-deleted — surface them
  // here too so operators have one place to bring removed items back.
  for (const r of sqlite.prepare('SELECT id, code, name, updated_at FROM billing_codes WHERE active = 0').all()) {
    out.push(item({ entity_type: 'billing_code', id: r.id, label: r.code, sub_label: r.name, removed_at: r.updated_at, kind: 'deactivated' }))
  }

  return out.sort((a, b) => String(b.removed_at || '').localeCompare(String(a.removed_at || '')))
}

// Per-type restore dispatch. `action`/`details` describe how the restore is
// recorded in the audit log.
const RESTORERS = {
  client: { restore: restoreClient, action: 'restored' },
  agreement: { restore: restoreAgreement, action: 'restored' },
  shift: { restore: restoreShift, action: 'restored' },
  report: { restore: restoreReport, action: 'restored' },
  template: { restore: restoreTemplate, action: 'restored' },
  billing_code: { restore: reactivateBillingCode, action: 'status_changed', details: { active: true } }
}

/**
 * Restore (or reactivate) a soft-deleted record by type and id.
 * @param {string} type entity type — client / agreement / shift / report / template / billing_code
 * @param {number} id
 * @returns {{entity_type:string, action:string, details:object, data:object}}
 */
export function restoreDeleted (type, id) {
  const spec = RESTORERS[type]
  if (!spec) throw new ApiError(400, 'BAD_TYPE', `Cannot restore unknown type "${type}"`)
  const data = spec.restore(id)
  return { entity_type: type, action: spec.action, details: spec.details || {}, data }
}
