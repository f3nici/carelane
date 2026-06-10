import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let clientService, sqlite

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  clientService = await import('../server/services/clientService.js')
})

const sample = () => ({
  first_name: 'Ada', last_name: 'Lovelace', preferred_name: 'Ada',
  ndis_number: '430000001', phone: '0400111222', suburb: 'Perth', state: 'WA', active: 1
})

describe('clientService PII + soft-delete rules', () => {
  it('encrypts PII at rest but returns plaintext to authorised callers', () => {
    const created = clientService.createClient(sample())
    expect(created.first_name).toBe('Ada')

    const raw = sqlite.prepare('SELECT * FROM clients WHERE id = ?').get(created.id)
    expect(raw.first_name).toMatch(/^enc:/)
    expect(raw.phone).toMatch(/^enc:/)
    // The NDIS blind index is a hex HMAC, never the raw number.
    expect(raw.ndis_number_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(raw.ndis_number_hash).not.toContain('430000001')
  })

  it('finds a client by NDIS number via the blind index', () => {
    const { rows } = clientService.listClients({ page: 1, perPage: 20, offset: 0 }, { q: '430000001' })
    expect(rows.length).toBe(1)
    expect(rows[0].preferred_name).toBe('Ada')
  })

  it('soft-deletes rather than hard-deleting regulated records', () => {
    const created = clientService.createClient({ ...sample(), ndis_number: '430000099' })
    clientService.deleteClient(created.id)

    // Row still physically present, just flagged deleted + inactive.
    const raw = sqlite.prepare('SELECT * FROM clients WHERE id = ?').get(created.id)
    expect(raw).toBeTruthy()
    expect(raw.deleted_at).toBeTruthy()
    expect(raw.active).toBe(0)

    // And no longer visible through the service.
    expect(() => clientService.getClient(created.id)).toThrow(/not found/i)
  })
})
