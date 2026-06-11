import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let scheduleService, recurrenceService, clientService, sqlite, clientId, workerId

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  clientService = await import('../server/services/clientService.js')
  scheduleService = await import('../server/services/scheduleService.js')
  recurrenceService = await import('../server/services/recurrenceService.js')
  workerId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w', 'x', 'admin')").run().lastInsertRowid
  clientId = clientService.createClient({ first_name: 'Ada', last_name: 'Lovelace', ndis_number: '430000020', active: 1 }).id
})

const base = (over = {}) => ({
  client_id: clientId,
  scheduled_date: '2026-07-01',
  start_time: '09:00',
  end_time: '12:00',
  plan_notes: 'Bring the support plan folder.',
  ...over
})

describe('scheduleService roster lifecycle', () => {
  it('encrypts plan notes at rest', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    const raw = sqlite.prepare('SELECT plan_notes, status FROM scheduled_shifts WHERE id = ?').get(s.id)
    expect(raw.plan_notes).toMatch(/^enc:/)
    expect(raw.status).toBe('scheduled')
    expect(scheduleService.getScheduled(s.id).plan_notes).toBe('Bring the support plan folder.')
  })

  it('clocks in and out, then prefill carries the actual times', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    expect(() => scheduleService.clockOut(s.id)).toThrow(/clock in/i)

    const inn = scheduleService.clockIn(s.id)
    expect(inn.status).toBe('in_progress')
    expect(inn.clock_in_at).toBeTruthy()

    const out = scheduleService.clockOut(s.id)
    expect(out.status).toBe('completed')
    expect(out.clock_out_at).toBeTruthy()

    const prefill = scheduleService.notePrefill(s.id)
    expect(prefill.client_id).toBe(clientId)
    expect(prefill.shift_date).toBe('2026-07-01')
    expect(prefill.start_time).toMatch(/^\d{2}:\d{2}$/)
    expect(prefill.already_noted).toBe(false)
  })

  it('creates a linked shift note from a scheduled shift', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    scheduleService.clockIn(s.id)
    scheduleService.clockOut(s.id)
    const { scheduled, note } = scheduleService.createNoteFromShift(s.id, { body: 'Went to the park.' }, workerId)
    expect(note.id).toBeTruthy()
    expect(note.body).toBe('Went to the park.')
    expect(scheduled.shift_note_id).toBe(note.id)
    // A second note is refused.
    expect(() => scheduleService.createNoteFromShift(s.id, { body: 'dup' }, workerId)).toThrow(/already/i)
  })

  it('cancels a shift and blocks editing afterwards', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    const cancelled = scheduleService.cancelScheduled(s.id)
    expect(cancelled.status).toBe('cancelled')
    expect(() => scheduleService.updateScheduled(s.id, { location: 'x' })).toThrow(/cannot be edited/i)
  })

  it('soft-deletes and restores a scheduled shift', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    scheduleService.deleteScheduled(s.id)
    expect(() => scheduleService.getScheduled(s.id)).toThrow(/not found/i)
    const restored = scheduleService.restoreScheduled(s.id)
    expect(restored.id).toBe(s.id)
  })
})

describe('recurrenceService occurrence expansion', () => {
  it('expands a weekly Mon/Wed series within a window', () => {
    // 2026-07-06 is a Monday. Mon=1, Wed=3.
    const dates = recurrenceService.occurrenceDates(
      { start_date: '2026-07-06', frequency: 'weekly', interval: 1, weekdays: [1, 3] },
      '2026-07-06', '2026-07-19'
    )
    expect(dates).toEqual(['2026-07-06', '2026-07-08', '2026-07-13', '2026-07-15'])
  })

  it('honours a fortnightly stride', () => {
    const dates = recurrenceService.occurrenceDates(
      { start_date: '2026-07-06', frequency: 'fortnightly', interval: 1, weekdays: [1] },
      '2026-07-06', '2026-08-03'
    )
    expect(dates).toEqual(['2026-07-06', '2026-07-20', '2026-08-03'])
  })

  it('materialises occurrences for a new series and does not duplicate them', () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    const rec = recurrenceService.createRecurrence({
      client_id: clientId, frequency: 'daily', interval: 1, start_date: future
    }, workerId)
    const count1 = sqlite.prepare('SELECT COUNT(*) AS c FROM scheduled_shifts WHERE recurrence_id = ?').get(rec.id).c
    expect(count1).toBeGreaterThan(0)
    // Re-running materialisation is idempotent.
    recurrenceService.materialiseDueOccurrences()
    const count2 = sqlite.prepare('SELECT COUNT(*) AS c FROM scheduled_shifts WHERE recurrence_id = ?').get(rec.id).c
    expect(count2).toBe(count1)
  })
})
