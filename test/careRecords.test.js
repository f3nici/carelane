import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let rpService, medService, clientService, deletedService, sqlite, workerId

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  workerId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w', 'x', 'admin')").run().lastInsertRowid
  rpService = await import('../server/services/restrictivePracticeService.js')
  medService = await import('../server/services/medicationService.js')
  clientService = await import('../server/services/clientService.js')
  deletedService = await import('../server/services/deletedService.js')
})

function makeClient () {
  return clientService.createClient({ first_name: 'Care', last_name: 'Subject', preferred_name: 'CS', active: 1 })
}

describe('restrictivePracticeService', () => {
  it('logs a restrictive practice and encrypts the narrative at rest', () => {
    const c = makeClient()
    const r = rpService.createRestrictivePractice(c.id, {
      practice_type: 'environmental', used_at_date: '2026-06-02', authorised: 1,
      authorisation_ref: 'BSP-12', description: 'Locked the kitchen door.', antecedent: 'Reaching for hot stove.'
    }, workerId)
    expect(r.description).toBe('Locked the kitchen door.')
    expect(r.authorised).toBe(1)

    const raw = sqlite.prepare('SELECT description FROM restrictive_practice_records WHERE id = ?').get(r.id)
    expect(raw.description).toMatch(/^enc:/)
    expect(raw.description).not.toContain('Locked')
  })

  it('lists newest first and filters by practice type', () => {
    const c = makeClient()
    rpService.createRestrictivePractice(c.id, { practice_type: 'chemical', used_at_date: '2026-01-01' }, workerId)
    rpService.createRestrictivePractice(c.id, { practice_type: 'physical', used_at_date: '2026-05-01' }, workerId)
    const list = rpService.listRestrictivePractices(c.id)
    expect(list[0].used_at_date).toBe('2026-05-01')
    expect(rpService.listRestrictivePractices(c.id, { practice_type: 'chemical' })).toHaveLength(1)
  })

  it('soft-deletes and restores through the deleted registry', () => {
    const c = makeClient()
    const r = rpService.createRestrictivePractice(c.id, { practice_type: 'seclusion', used_at_date: '2026-06-02' }, workerId)
    rpService.deleteRestrictivePractice(c.id, r.id)
    expect(() => rpService.getRestrictivePractice(c.id, r.id)).toThrow(/not found/i)
    const entry = deletedService.listDeleted().find(i => i.entity_type === 'restrictive_practice' && i.id === r.id)
    expect(entry).toBeTruthy()
    deletedService.restoreDeleted('restrictive_practice', r.id)
    expect(rpService.getRestrictivePractice(c.id, r.id).id).toBe(r.id)
  })
})

describe('medicationService', () => {
  it('records an administration with the name plain and notes encrypted', () => {
    const c = makeClient()
    const m = medService.createMedicationRecord(c.id, {
      medication_name: 'Paracetamol', dose: '500mg', route: 'oral', administered_date: '2026-06-02',
      status: 'administered', notes: 'Given after lunch.'
    }, workerId)
    expect(m.medication_name).toBe('Paracetamol')
    expect(m.notes).toBe('Given after lunch.')

    const raw = sqlite.prepare('SELECT medication_name, notes FROM medication_records WHERE id = ?').get(m.id)
    expect(raw.medication_name).toBe('Paracetamol') // listable, kept plain
    expect(raw.notes).toMatch(/^enc:/)
  })

  it('filters by administration status', () => {
    const c = makeClient()
    medService.createMedicationRecord(c.id, { medication_name: 'A', administered_date: '2026-06-01', status: 'refused' }, workerId)
    medService.createMedicationRecord(c.id, { medication_name: 'B', administered_date: '2026-06-02', status: 'administered' }, workerId)
    expect(medService.listMedicationRecords(c.id, { status: 'refused' })).toHaveLength(1)
  })

  it('soft-deletes and restores through the deleted registry', () => {
    const c = makeClient()
    const m = medService.createMedicationRecord(c.id, { medication_name: 'Insulin', administered_date: '2026-06-02', status: 'administered' }, workerId)
    medService.deleteMedicationRecord(c.id, m.id)
    expect(() => medService.getMedicationRecord(c.id, m.id)).toThrow(/not found/i)
    const entry = deletedService.listDeleted().find(i => i.entity_type === 'medication' && i.id === m.id)
    expect(entry).toBeTruthy()
    deletedService.restoreDeleted('medication', m.id)
    expect(medService.getMedicationRecord(c.id, m.id).id).toBe(m.id)
  })
})
