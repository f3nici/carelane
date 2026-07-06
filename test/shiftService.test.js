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

  it('derives the duration from the times and ignores any client value', () => {
    // 2h15m rounds to 2.25 hours, and a bogus client-supplied duration is ignored.
    const shift = shiftService.createShift(baseShift({ start_time: '09:00', end_time: '11:15', duration_hours: 2.15 }), workerId)
    expect(shift.duration_hours).toBe(2.25)
  })

  it('recalculates the duration whenever the times change on update', () => {
    const shift = shiftService.createShift(baseShift({ start_time: '09:00', end_time: '11:00' }), workerId)
    expect(shift.duration_hours).toBe(2)
    const updated = shiftService.updateShift(shift.id, { end_time: '11:45' })
    expect(updated.end_time).toBe('11:45')
    expect(updated.duration_hours).toBe(2.75)
  })

  it('rounds odd durations to the nearest quarter hour', () => {
    // 2h10m -> 2.1667 rounds up to 2.25
    expect(shiftService.createShift(baseShift({ start_time: '09:00', end_time: '11:10' }), workerId).duration_hours).toBe(2.25)
    // 2h05m -> 2.0833 rounds down to 2.0
    expect(shiftService.createShift(baseShift({ start_time: '09:00', end_time: '11:05' }), workerId).duration_hours).toBe(2)
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

  it('searches the encrypted note body and plaintext fields by keyword (blind-index FTS)', () => {
    const c = clientService.createClient({ first_name: 'Ada', last_name: 'Lovelace', ndis_number: '430000099', active: 1 }).id
    const s1 = shiftService.createShift(baseShift({ client_id: c, shift_date: '2026-05-02', body: 'Attended a hydrotherapy session.' }), workerId)
    shiftService.createShift(baseShift({ client_id: c, shift_date: '2026-05-03', body: 'Meal prep and cleaning.', location: 'Community centre' }), workerId)
    const pg = { page: 1, perPage: 100, offset: 0 }
    // Matches the encrypted body of the first note only (case-insensitively).
    const hydro = shiftService.listShifts(pg, { client_id: c, q: 'Hydrotherapy' })
    expect(hydro.total).toBe(1)
    expect(hydro.rows[0].body).toMatch(/hydrotherapy/)
    // Matches a plaintext location field.
    expect(shiftService.listShifts(pg, { client_id: c, q: 'community' }).total).toBe(1)
    // Multi-word queries are AND-ed across the note's words.
    expect(shiftService.listShifts(pg, { client_id: c, q: 'meal cleaning' }).total).toBe(1)
    expect(shiftService.listShifts(pg, { client_id: c, q: 'meal hydrotherapy' }).total).toBe(0)
    // No match returns nothing.
    expect(shiftService.listShifts(pg, { client_id: c, q: 'zzz-nope' }).total).toBe(0)

    // The index stores only keyed token hashes — never the note's plaintext words.
    const indexed = sqlite.prepare('SELECT tokens FROM shift_notes_fts WHERE rowid = ?').get(s1.id).tokens
    expect(indexed).not.toMatch(/hydrotherapy/i)
    expect(indexed).toMatch(/^t[0-9a-f]/)

    // Editing the body re-indexes it: the old word stops matching, the new matches.
    shiftService.updateShift(s1.id, { body: 'Went for a swim at the pool.' })
    expect(shiftService.listShifts(pg, { client_id: c, q: 'hydrotherapy' }).total).toBe(0)
    expect(shiftService.listShifts(pg, { client_id: c, q: 'swim' }).total).toBe(1)
  })

  it('filters by an exact date and by a date range', () => {
    const c = clientService.createClient({ first_name: 'Alan', last_name: 'Turing', ndis_number: '430000098', active: 1 }).id
    shiftService.createShift(baseShift({ client_id: c, shift_date: '2026-03-01' }), workerId)
    shiftService.createShift(baseShift({ client_id: c, shift_date: '2026-03-15' }), workerId)
    shiftService.createShift(baseShift({ client_id: c, shift_date: '2026-04-01' }), workerId)
    const pg = { page: 1, perPage: 100, offset: 0 }
    expect(shiftService.listShifts(pg, { client_id: c, date: '2026-03-15' }).total).toBe(1)
    // Inclusive range spanning the two March shifts.
    const march = shiftService.listShifts(pg, { client_id: c, date_from: '2026-03-01', date_to: '2026-03-31' })
    expect(march.total).toBe(2)
    expect(march.rows.every(r => r.shift_date.startsWith('2026-03'))).toBe(true)
    // Open-ended lower bound.
    expect(shiftService.listShifts(pg, { client_id: c, date_from: '2026-03-20' }).total).toBe(1)
  })

  it('sorts by participant name and by date order', () => {
    const zed = clientService.createClient({ first_name: 'Zed', last_name: 'Zephyr', preferred_name: 'Zed', ndis_number: '430000097', active: 1 }).id
    const abe = clientService.createClient({ first_name: 'Abe', last_name: 'Abbott', preferred_name: 'Abe', ndis_number: '430000096', active: 1 }).id
    shiftService.createShift(baseShift({ client_id: zed, shift_date: '2026-02-01' }), workerId)
    shiftService.createShift(baseShift({ client_id: abe, shift_date: '2026-02-02' }), workerId)
    const pg = { page: 1, perPage: 100, offset: 0 }
    const byClient = shiftService.listShifts(pg, { sort: 'client' }).rows.filter(r => [zed, abe].includes(r.client_id))
    expect(byClient[0].client_display_name).toBe('Abe')
    // Oldest-first date sort within the same participant set.
    const asc = shiftService.listShifts(pg, { sort: 'date_asc' }).rows.map(r => r.shift_date)
    expect([...asc]).toEqual([...asc].sort())
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

  it("drops a flagged note from the incident:'open' filter once its incident report is closed", async () => {
    const incidentService = await import('../server/services/incidentService.js')
    const pg = { page: 1, perPage: 100, offset: 0 }
    const shift = shiftService.createShift(baseShift({ shift_date: '2026-08-01', incident_flag: 1, incident_details: 'Slip in bathroom.' }), workerId)
    const open = () => shiftService.listShifts(pg, { client_id: clientId, incident: 'open' }).rows.some(r => r.id === shift.id)
    const all = () => shiftService.listShifts(pg, { client_id: clientId, incident: 'true' }).rows.some(r => r.id === shift.id)

    // Flagged, no report yet: appears in both.
    expect(open()).toBe(true)
    expect(all()).toBe(true)

    const report = incidentService.createFromShift(shift.id, workerId)
    // An open report still needs attention — still shown.
    expect(open()).toBe(true)

    incidentService.updateIncident(report.id, { status: 'closed' })
    // Resolved: gone from the dashboard warning, but still in the full incident list.
    expect(open()).toBe(false)
    expect(all()).toBe(true)
  })
})
