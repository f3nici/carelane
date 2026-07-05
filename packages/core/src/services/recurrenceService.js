import { ApiError } from '../errors.js'

/**
 * Build the recurring-appointment service bound to a host context. The nightly
 * cron wrapper (`scheduleMaterialisation`) stays server-side; the portable
 * occurrence expansion + materialisation live here. Google Calendar mirroring is
 * read lazily from `ctx.googleCalendar` (no-op when absent).
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services
 */
export function createRecurrenceService (ctx, services) {
  const { sqlite } = ctx
  const { encrypt, decryptFields } = services.crypto
  const { clientDisplayName } = services.client
  const googleCalendar = {
    syncScheduledShift: (...a) => ctx.googleCalendar?.syncScheduledShift?.(...a),
    removeScheduledShift: (...a) => ctx.googleCalendar?.removeScheduledShift?.(...a)
  }

  /**
   * Recurring-appointment series. A series stores a simple recurrence rule; its
   * individual occurrences are materialised into `scheduled_shifts` on a rolling
   * horizon (default 60 days) by {@link materialiseDueOccurrences}, which runs
   * nightly and on every series create/update.
   */

  const ENCRYPTED = ['plan_notes']
  const HORIZON_DAYS = 60
  const COLUMNS = ['client_id', 'title', 'frequency', 'interval', 'weekdays', 'start_date',
    'until_date', 'start_time', 'end_time', 'billing_code_id', 'location', 'plan_notes', 'active']

  const now = () => new Date(ctx.now()).toISOString()
  const today = () => new Date(ctx.now()).toISOString().slice(0, 10)
  const parse = s => new Date(`${s}T00:00:00Z`)
  const fmt = d => d.toISOString().slice(0, 10)
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }

  function toRecurrence (row) {
    if (!row) return row
    const r = decryptFields(row, ENCRYPTED)
    r.weekdays = r.weekdays ? JSON.parse(r.weekdays) : null
    return r
  }

  /**
   * Expand a recurrence rule into concrete ISO dates within [from, to] inclusive.
   * @param {object} rec recurrence row (weekdays already parsed to an array|null)
   * @param {string} from ISO date
   * @param {string} to ISO date
   * @returns {string[]}
   */
  function occurrenceDates (rec, from, to) {
    const start = parse(rec.start_date)
    const until = rec.until_date ? parse(rec.until_date) : null
    let cursor = parse(from) < start ? start : parse(from)
    const end = until && until < parse(to) ? until : parse(to)
    const out = []
    const interval = Math.max(1, rec.interval || 1)
    const set = Array.isArray(rec.weekdays) && rec.weekdays.length ? new Set(rec.weekdays) : null

    if (rec.frequency === 'weekly' || rec.frequency === 'fortnightly') {
      const stride = rec.frequency === 'fortnightly' ? 2 * interval : interval
      const weekStart = addDays(start, -start.getUTCDay()) // Sunday of the start week
      const days = set || new Set([start.getUTCDay()])
      for (let d = cursor; d <= end; d = addDays(d, 1)) {
        if (!days.has(d.getUTCDay())) continue
        const weekIndex = Math.floor((d - weekStart) / (7 * 86400000))
        if (weekIndex >= 0 && weekIndex % stride === 0) out.push(fmt(d))
      }
    } else if (rec.frequency === 'daily') {
      for (let d = cursor; d <= end; d = addDays(d, 1)) {
        const diff = Math.round((d - start) / 86400000)
        if (diff >= 0 && diff % interval === 0) out.push(fmt(d))
      }
    } else if (rec.frequency === 'monthly') {
      const dom = start.getUTCDate()
      for (let d = cursor; d <= end; d = addDays(d, 1)) {
        if (d.getUTCDate() !== dom) continue
        const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + (d.getUTCMonth() - start.getUTCMonth())
        if (months >= 0 && months % interval === 0) out.push(fmt(d))
      }
    }
    return out
  }

  /**
   * Insert any missing occurrences for a single active series within the horizon.
   * Existing occurrences for a date (in any state, incl. cancelled) are never
   * duplicated, so cancellations stick. Returns the number created.
   * @param {object} rec recurrence row (decrypted, weekdays parsed)
   * @param {string} horizonEnd ISO date
   * @returns {number}
   */
  function materialiseSeries (rec, horizonEnd) {
    const from = rec.start_date < today() ? today() : rec.start_date
    const dates = occurrenceDates(rec, from, horizonEnd)
    const existing = new Set(sqlite.prepare('SELECT scheduled_date FROM scheduled_shifts WHERE recurrence_id = ?')
      .all(rec.id).map(r => r.scheduled_date))
    const ts = now()
    const planNotes = encrypt(rec.plan_notes)
    const insert = sqlite.prepare(`INSERT INTO scheduled_shifts
      (client_id, worker_id, recurrence_id, title, scheduled_date, start_time, end_time, billing_code_id, location, plan_notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
    const created = []
    for (const date of dates) {
      if (existing.has(date)) continue
      const id = insert.run(rec.client_id, rec.worker_id, rec.id, rec.title, date, rec.start_time,
        rec.end_time, rec.billing_code_id, rec.location, planNotes, ts, ts).lastInsertRowid
      created.push({ id, client_id: rec.client_id, title: rec.title, scheduled_date: date, start_time: rec.start_time, end_time: rec.end_time, location: rec.location, status: 'scheduled', google_event_id: null })
    }
    // Mirror the new occurrences into Google (best-effort, no-op when disabled).
    for (const occ of created) googleCalendar.syncScheduledShift(occ)
    return created.length
  }

  /**
   * Materialise occurrences for every active series up to the horizon. Safe to run
   * repeatedly (idempotent); called nightly and after series changes.
   * @param {number} [horizonDays]
   * @returns {number} total occurrences created
   */
  function materialiseDueOccurrences (horizonDays = HORIZON_DAYS) {
    const horizonEnd = fmt(addDays(parse(today()), horizonDays))
    const rows = sqlite.prepare('SELECT * FROM shift_recurrences WHERE deleted_at IS NULL AND active = 1').all()
    let total = 0
    for (const row of rows) total += materialiseSeries(toRecurrence(row), horizonEnd)
    return total
  }

  /** List recurrence series (decrypted) with participant display names. */
  function listRecurrences () {
    const rows = sqlite.prepare(`SELECT r.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name, bc.code AS billing_code
      FROM shift_recurrences r JOIN clients c ON c.id = r.client_id
      LEFT JOIN billing_codes bc ON bc.id = r.billing_code_id
      WHERE r.deleted_at IS NULL ORDER BY r.created_at DESC`).all()
    return rows.map(row => {
      const r = toRecurrence(row)
      r.client_display_name = clientDisplayName(row)
      delete r.client_first_name
      delete r.client_last_name
      return r
    })
  }

  /** Fetch one series (decrypted) or throw 404. */
  function getRecurrence (id) {
    const row = sqlite.prepare('SELECT * FROM shift_recurrences WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Recurring appointment not found')
    return toRecurrence(row)
  }

  /**
   * Create a recurrence series and materialise its near-term occurrences.
   * @param {object} data validated payload
   * @param {number} workerId
   */
  function createRecurrence (data, workerId) {
    const ts = now()
    const values = COLUMNS.map(c => {
      if (c === 'weekdays') return data.weekdays ? JSON.stringify(data.weekdays) : null
      if (c === 'plan_notes') return encrypt(data.plan_notes ?? null)
      if (c === 'active') return data.active ?? 1
      if (c === 'interval') return data.interval ?? 1
      if (c === 'frequency') return data.frequency ?? 'weekly'
      return data[c] ?? null
    })
    const cols = [...COLUMNS, 'worker_id', 'created_at', 'updated_at']
    // Roster the series (and every occurrence it materialises) to the assigned
    // worker when the admin set one, else the acting user.
    const id = sqlite.prepare(`INSERT INTO shift_recurrences (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values, data.worker_id || workerId, ts, ts).lastInsertRowid
    const horizonEnd = fmt(addDays(parse(today()), HORIZON_DAYS))
    materialiseSeries(getRecurrence(id), horizonEnd)
    return getRecurrence(id)
  }

  /**
   * Update a series. Future un-started occurrences are regenerated to reflect the
   * change; past, in-progress and completed occurrences are left untouched.
   * @param {number} id
   * @param {object} data
   */
  function updateRecurrence (id, data) {
    getRecurrence(id)
    const sets = []
    const params = []
    for (const col of COLUMNS) {
      if (!(col in data)) continue
      if (col === 'weekdays') { sets.push('weekdays = ?'); params.push(data.weekdays ? JSON.stringify(data.weekdays) : null); continue }
      if (col === 'plan_notes') { sets.push('plan_notes = ?'); params.push(encrypt(data.plan_notes ?? null)); continue }
      sets.push(`${col} = ?`)
      params.push(data[col] ?? null)
    }
    if (sets.length) {
      sets.push('updated_at = ?')
      params.push(now(), id)
      sqlite.prepare(`UPDATE shift_recurrences SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }
    removeFutureOccurrences(id)
    const horizonEnd = fmt(addDays(parse(today()), HORIZON_DAYS))
    const rec = getRecurrence(id)
    if (rec.active) materialiseSeries(rec, horizonEnd)
    return rec
  }

  /** Delete future, not-yet-started occurrences of a series (and their events). */
  function removeFutureOccurrences (recurrenceId) {
    const rows = sqlite.prepare(`SELECT * FROM scheduled_shifts
      WHERE recurrence_id = ? AND status = 'scheduled' AND clock_in_at IS NULL AND deleted_at IS NULL AND scheduled_date >= ?`)
      .all(recurrenceId, today())
    for (const row of rows) googleCalendar.removeScheduledShift(row)
    sqlite.prepare(`DELETE FROM scheduled_shifts
      WHERE recurrence_id = ? AND status = 'scheduled' AND clock_in_at IS NULL AND deleted_at IS NULL AND scheduled_date >= ?`)
      .run(recurrenceId, today())
  }

  /**
   * Soft-delete a series and remove its future un-started occurrences. History
   * (started/completed occurrences) is retained.
   * @param {number} id
   */
  function deleteRecurrence (id) {
    getRecurrence(id)
    removeFutureOccurrences(id)
    sqlite.prepare('UPDATE shift_recurrences SET deleted_at = ?, active = 0, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  return {
    occurrenceDates,
    materialiseDueOccurrences,
    listRecurrences,
    getRecurrence,
    createRecurrence,
    updateRecurrence,
    deleteRecurrence
  }
}
