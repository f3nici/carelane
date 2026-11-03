import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let square, sqlite

beforeAll(async () => {
  // No SQUARE_ACCESS_TOKEN in the test env → integration stays a no-op.
  ({ sqlite } = await freshDb())
  square = await import('../server/services/squareService.js')
})

describe('squareService status', () => {
  it('reports not-configured when no access token is set', () => {
    expect(square.isConfigured()).toBe(false)
    const s = square.status()
    expect(s.configured).toBe(false)
    expect(s.enabled).toBe(false)
    expect(s.invoice_count).toBe(0)
    expect(s.environment).toBe('sandbox')
  })

  it('migration created the square_invoices table and clients.square_customer_id', () => {
    const cols = sqlite.prepare('PRAGMA table_info(clients)').all().map(c => c.name)
    expect(cols).toContain('square_customer_id')
    expect(() => sqlite.prepare('SELECT * FROM square_invoices').all()).not.toThrow()
  })
})

describe('squareService.resolveLineItem', () => {
  const code = { code: '01_011_0107_1_1', name: 'Self-care', unit: 'H', price_cap_standard: 67.56 }

  it('uses the per-client custom rate × hours (in minor units)', () => {
    const line = square.resolveLineItem({ duration_hours: 2, shift_date: '2026-06-01' }, code, 70)
    expect(line.amountCents).toBe(14000)
    expect(line.quantity).toBe(2)
    expect(line.name).toContain('01_011_0107_1_1')
    expect(line.note).toContain('2026-06-01')
  })

  it('falls back to the standard price cap when there is no custom rate', () => {
    const line = square.resolveLineItem({ duration_hours: 1, shift_date: '2026-06-01' }, code, null)
    expect(line.amountCents).toBe(6756)
  })

  it('rounds fractional-hour amounts to whole cents', () => {
    const line = square.resolveLineItem({ duration_hours: 1.5, shift_date: '2026-06-01' }, code, 67.56)
    expect(line.amountCents).toBe(Math.round(67.56 * 1.5 * 100))
  })

  it('bills quantity 1 for non-hourly units', () => {
    const each = { code: '01_799_0107_1_1', name: 'Travel', unit: 'E', price_cap_standard: 1 }
    const line = square.resolveLineItem({ duration_hours: null, shift_date: '2026-06-01' }, each, 12.5)
    expect(line.quantity).toBe(1)
    expect(line.amountCents).toBe(1250)
  })

  it('throws when no rate is available at all', () => {
    const noCap = { code: 'X', name: 'No cap', unit: 'H', price_cap_standard: null }
    expect(() => square.resolveLineItem({ duration_hours: 1, shift_date: '2026-06-01' }, noCap, null)).toThrow()
  })

  it('throws when an hourly shift has no duration', () => {
    expect(() => square.resolveLineItem({ duration_hours: null, shift_date: '2026-06-01' }, code, 70)).toThrow()
  })
})

describe('squareService.buildInvoiceDescription', () => {
  const pm = { plan_manager_name: 'Plan Partners', plan_manager_contact: 'invoices@planpartners.example' }

  it('puts the operator message first and the plan manager beneath it', () => {
    const d = square.buildInvoiceDescription(pm, { message: 'Thanks for your business.\nBSB 000-000', includePlanManager: true })
    expect(d).toBe('Thanks for your business.\nBSB 000-000\n\nPlan Manager: Plan Partners invoices@planpartners.example')
  })

  it('keeps the operator message alone when the plan manager is turned off', () => {
    expect(square.buildInvoiceDescription(pm, { message: 'Thanks!', includePlanManager: false })).toBe('Thanks!')
  })

  it('keeps the original plan-manager-only message when no operator message is set', () => {
    expect(square.buildInvoiceDescription(pm, { message: '', includePlanManager: true }))
      .toBe('Plan Manager: Plan Partners invoices@planpartners.example')
  })

  it('includes the plan manager by default', () => {
    expect(square.buildInvoiceDescription(pm)).toContain('Plan Manager:')
  })

  it('returns undefined (field omitted) when there is nothing to write', () => {
    expect(square.buildInvoiceDescription(pm, { message: '  ', includePlanManager: false })).toBeUndefined()
    expect(square.buildInvoiceDescription({}, { message: '', includePlanManager: true })).toBeUndefined()
  })

  it('status() exposes the message settings with their defaults', () => {
    const s = square.status()
    expect(s.invoice_message).toBe('')
    expect(s.include_plan_manager).toBe(true)
  })
})
