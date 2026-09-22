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

/** ISO date `n` days from today — keeps the expectations from going stale. */
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

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

  it('honours operator-corrected times on the note and derives the duration', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    scheduleService.clockIn(s.id)
    scheduleService.clockOut(s.id)
    const { note } = scheduleService.createNoteFromShift(
      s.id,
      { body: 'Park visit.', start_time: '09:00', end_time: '11:15' },
      workerId
    )
    expect(note.start_time).toBe('09:00')
    expect(note.end_time).toBe('11:15')
    // 2h15m is 2.25 hours, not 2.15.
    expect(note.duration_hours).toBe(2.25)
  })

  it('cancels a shift and blocks editing afterwards', () => {
    const s = scheduleService.createScheduled(base(), workerId)
    const cancelled = scheduleService.cancelScheduled(s.id)
    expect(cancelled.status).toBe('cancelled')
    expect(() => scheduleService.updateScheduled(s.id, { location: 'x' })).toThrow(/cannot be edited/i)
  })

  it('auto-creates a "Cancelled shift" note with the planned times on cancel', async () => {
    const shiftService = await import('../server/services/shiftService.js')
    const s = scheduleService.createScheduled(base({ start_time: '10:00', end_time: '13:30' }), workerId)
    const cancelled = scheduleService.cancelScheduled(s.id)
    expect(cancelled.shift_note_id).toBeTruthy()
    const note = shiftService.getShift(cancelled.shift_note_id)
    expect(note.start_time).toBe('10:00')
    expect(note.end_time).toBe('13:30')
    expect(note.worker_id).toBe(workerId)
    expect(note.client_id).toBe(clientId)
    expect(note.body).toBe('Cancelled shift')
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
    const rec = recurrenceService.createRecurrence({
      client_id: clientId, frequency: 'daily', interval: 1, start_date: day(7)
    }, workerId)
    const count1 = sqlite.prepare('SELECT COUNT(*) AS c FROM scheduled_shifts WHERE recurrence_id = ?').get(rec.id).c
    expect(count1).toBeGreaterThan(0)
    // Re-running materialisation is idempotent.
    recurrenceService.materialiseDueOccurrences()
    const count2 = sqlite.prepare('SELECT COUNT(*) AS c FROM scheduled_shifts WHERE recurrence_id = ?').get(rec.id).c
    expect(count2).toBe(count1)
  })
})

describe('recurrenceService whole-series management', () => {
  /** An open-ended daily series starting today, as the roster would hold it. */
  const openEndedSeries = (over = {}) => recurrenceService.createRecurrence({
    client_id: clientId, frequency: 'daily', interval: 1, start_date: day(0),
    start_time: '09:00', end_time: '11:00', location: 'Home', ...over
  }, workerId)

  const occurrences = recId => sqlite.prepare(
    'SELECT * FROM scheduled_shifts WHERE recurrence_id = ? AND deleted_at IS NULL ORDER BY scheduled_date'
  ).all(recId)

  it('counts the upcoming occurrences an edit or delete would rewrite', () => {
    const rec = openEndedSeries()
    expect(rec.upcoming_count).toBe(occurrences(rec.id).length)
    expect(rec.kept_count).toBe(0)
    expect(rec.next_date).toBe(day(0))
  })

  it('applies an edit to every upcoming occurrence at once', () => {
    const rec = openEndedSeries()
    const before = occurrences(rec.id).length
    const updated = recurrenceService.updateRecurrence(rec.id, { start_time: '13:00', location: 'Library' }, workerId)
    expect(updated.occurrences_replaced).toBe(before)
    expect(updated.occurrences_created).toBe(before)
    const after = occurrences(rec.id)
    expect(after.length).toBe(before)
    expect(after.every(o => o.start_time === '13:00' && o.location === 'Library')).toBe(true)
  })

  it('re-rosters a whole series to another support worker', () => {
    const other = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w2', 'x', 'worker')").run().lastInsertRowid
    const rec = openEndedSeries()
    const updated = recurrenceService.updateRecurrence(rec.id, { worker_id: other }, workerId)
    expect(updated.worker_id).toBe(other)
    expect(occurrences(rec.id).every(o => o.worker_id === other)).toBe(true)
  })

  it('leaves a started occurrence alone when the series is edited', () => {
    const rec = openEndedSeries()
    const first = occurrences(rec.id)[0]
    scheduleService.clockIn(first.id)
    recurrenceService.updateRecurrence(rec.id, { start_time: '15:00' }, workerId)
    const kept = sqlite.prepare('SELECT * FROM scheduled_shifts WHERE id = ?').get(first.id)
    expect(kept.status).toBe('in_progress')
    expect(kept.start_time).toBe('09:00')
  })

  it('stops an open-ended series from a date, keeping the earlier occurrences', () => {
    const rec = openEndedSeries()
    const cut = day(3)
    const ended = recurrenceService.endRecurrence(rec.id, cut)
    expect(ended.until_date).toBe(day(2))
    expect(ended.occurrences_removed).toBeGreaterThan(0)
    const left = occurrences(rec.id)
    expect(left.length).toBe(3)
    expect(left.every(o => o.scheduled_date < cut)).toBe(true)
    // Still active while the cap is in the future, so the nightly run may fill
    // up to it — but it can never produce a shift past the cap.
    expect(ended.active).toBe(1)
    recurrenceService.materialiseDueOccurrences()
    expect(occurrences(rec.id).length).toBe(3)
  })

  it('deactivates a series ended as of today', () => {
    const rec = openEndedSeries()
    const ended = recurrenceService.endRecurrence(rec.id)
    expect(ended.active).toBe(0)
    expect(occurrences(rec.id).length).toBe(0)
  })

  it('deletes a whole series but keeps the shifts already worked', () => {
    const rec = openEndedSeries()
    const first = occurrences(rec.id)[0]
    scheduleService.clockIn(first.id)
    const upcoming = rec.upcoming_count
    const result = recurrenceService.deleteRecurrence(rec.id)
    expect(result.occurrences_removed).toBe(upcoming - 1)
    expect(() => recurrenceService.getRecurrence(rec.id)).toThrow(/not found/i)
    const left = occurrences(rec.id)
    expect(left.map(o => o.id)).toEqual([first.id])
    // A deleted series never materialises again.
    recurrenceService.materialiseDueOccurrences()
    expect(occurrences(rec.id).length).toBe(1)
  })

  it('lists series with the labels and counts the management UI shows', () => {
    const rec = openEndedSeries({ title: 'Community access' })
    const listed = recurrenceService.listRecurrences().find(r => r.id === rec.id)
    expect(listed.client_display_name).toBe('Ada Lovelace')
    expect(listed.title).toBe('Community access')
    expect(listed.upcoming_count).toBeGreaterThan(0)
    expect(listed.next_date).toBe(day(0))
  })
})
