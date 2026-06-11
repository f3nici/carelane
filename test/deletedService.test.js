import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let deletedService, clientService, billingService

beforeAll(async () => {
  await freshDb()
  deletedService = await import('../server/services/deletedService.js')
  clientService = await import('../server/services/clientService.js')
  billingService = await import('../server/services/billingService.js')
})

describe('deletedService', () => {
  it('lists and restores a soft-deleted client', () => {
    const c = clientService.createClient({ first_name: 'Dell', last_name: 'Eted', preferred_name: 'Dee', active: 1 })
    clientService.deleteClient(c.id)
    expect(() => clientService.getClient(c.id)).toThrow(/not found/i)

    const listed = deletedService.listDeleted()
    const entry = listed.find(i => i.entity_type === 'client' && i.id === c.id)
    expect(entry).toBeTruthy()
    expect(entry.label).toBe('Dee')
    expect(entry.kind).toBe('deleted')

    const res = deletedService.restoreDeleted('client', c.id)
    expect(res.action).toBe('restored')
    expect(clientService.getClient(c.id).id).toBe(c.id)
    expect(deletedService.listDeleted().some(i => i.entity_type === 'client' && i.id === c.id)).toBe(false)
  })

  it('surfaces and reactivates a deactivated billing code', () => {
    const code = billingService.createBillingCode({
      code: '01_011_0107_1_1', name: 'Assistance', unit: 'H', active: 1, quote_required: 0
    })
    billingService.deactivateBillingCode(code.id)

    const entry = deletedService.listDeleted().find(i => i.entity_type === 'billing_code' && i.id === code.id)
    expect(entry).toBeTruthy()
    expect(entry.kind).toBe('deactivated')

    const res = deletedService.restoreDeleted('billing_code', code.id)
    expect(res.action).toBe('status_changed')
    expect(billingService.getBillingCode(code.id).active).toBe(1)
  })

  it('rejects an unknown type', () => {
    expect(() => deletedService.restoreDeleted('nope', 1)).toThrow(/unknown type/i)
  })
})
