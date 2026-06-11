import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let shiftService, clientService, sqlite, clientId, workerId

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  clientService = await import('../server/services/clientService.js')
  shiftService = await import('../server/services/shiftService.js')
  workerId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w', 'x', 'admin')").run().lastInsertRowid
  clientId = clientService.createClient({ first_name: 'Grace', last_name: 'Hopper', ndis_number: '430000010', active: 1 }).id
})

const baseShift = (over = {}) => ({
  client_id: clientId,
  shift_date: '2026-06-01',
  body: 'Supported with shopping.',
  incident_flag: 0,
  follow_up_required: 0,
  billed: 0,
  finalised: 0,
  ...over
})

describe('shiftService business rules', () => {
  it('encrypts the note body at rest', () => {
    const shift = shiftService.createShift(baseShift(), workerId)
    const raw = sqlite.prepare('SELECT body FROM shift_notes WHERE id = ?').get(shift.id)
    expect(raw.body).toMatch(/^enc:/)
    expect(shiftService.getShift(shift.id).body).toBe('Supported with shopping.')
  })

  it('refuses to delete an incident-flagged note', () => {
    const shift = shiftService.createShift(baseShift({ incident_flag: 1, incident_details: 'Fall, no injury.' }), workerId)
    expect(() => shiftService.deleteShift(shift.id)).toThrow(/incident/i)
    expect(sqlite.prepare('SELECT deleted_at FROM shift_notes WHERE id = ?').get(shift.id).deleted_at).toBeNull()
  })

  it('locks a finalised note to billing-only changes', () => {
    const shift = shiftService.createShift(baseShift({ finalised: 1 }), workerId)
    // Editing the body of a finalised note is rejected.
    expect(() => shiftService.updateShift(shift.id, { body: 'rewrite' })).toThrow(/finalised/i)
    // But marking it billed is allowed.
    const billed = shiftService.updateShift(shift.id, { billed: 1 })
    expect(billed.billed).toBe(1)
    expect(billed.body).toBe('Supported with shopping.')
  })

  it('can reopen a finalised note by sending finalised: 0', () => {
    const shift = shiftService.createShift(baseShift({ finalised: 1 }), workerId)
    const reopened = shiftService.updateShift(shift.id, { finalised: 0, body: 'edited after reopen' })
    expect(reopened.finalised).toBe(0)
    expect(reopened.body).toBe('edited after reopen')
  })

  it('soft-deletes a normal note', () => {
    const shift = shiftService.createShift(baseShift(), workerId)
    shiftService.deleteShift(shift.id)
    expect(sqlite.prepare('SELECT deleted_at FROM shift_notes WHERE id = ?').get(shift.id).deleted_at).toBeTruthy()
    expect(() => shiftService.getShift(shift.id)).toThrow(/not found/i)
  })

  it('archives a note out of the default list and back again', () => {
    const shift = shiftService.createShift(baseShift({ shift_date: '2026-07-01' }), workerId)
    const pg = { page: 1, perPage: 100, offset: 0 }

    shiftService.archiveShift(shift.id)
    expect(shiftService.getShift(shift.id).archived_at).toBeTruthy()
    // Hidden from the active list, visible in the archived list.
    expect(shiftService.listShifts(pg, { client_id: clientId }).rows.some(r => r.id === shift.id)).toBe(false)
    expect(shiftService.listShifts(pg, { client_id: clientId, archived: 'true' }).rows.some(r => r.id === shift.id)).toBe(true)

    shiftService.unarchiveShift(shift.id)
    expect(shiftService.getShift(shift.id).archived_at).toBeNull()
    expect(shiftService.listShifts(pg, { client_id: clientId }).rows.some(r => r.id === shift.id)).toBe(true)
  })
})
