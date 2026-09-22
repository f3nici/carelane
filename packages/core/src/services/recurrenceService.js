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
  // Fields an existing series accepts on edit. `worker_id` is settable here but
  // not part of COLUMNS because create derives it from the acting user; on an
  // edit an admin may re-roster the whole series to a different support worker.
  const UPDATABLE = [...COLUMNS, 'worker_id']

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
   * SQL predicate for the occurrences a series-wide edit or delete may touch:
   * still merely planned (never clocked into), not already deleted, and dated on
   * or after the cut-off. Everything else is history and is left alone.
   */
  const EDITABLE_OCCURRENCE = `recurrence_id = ? AND status = 'scheduled'
    AND clock_in_at IS NULL AND deleted_at IS NULL AND scheduled_date >= ?`

  /**
   * Count a series' occurrences either side of the cut-off, so the caller (and
   * the confirmation prompt in the UI) can say exactly how many upcoming shifts
   * an "edit them all" / "delete them all" will rewrite, and how many worked or
   * cancelled ones stay untouched.
   * @param {number} recurrenceId
   * @param {string} [from] ISO date the upcoming window starts at
   * @returns {{upcoming_count:number, kept_count:number, next_date:string|null}}
   */
  function occurrenceSummary (recurrenceId, from = today()) {
    const up = sqlite.prepare(`SELECT COUNT(*) AS c, MIN(scheduled_date) AS next
      FROM scheduled_shifts WHERE ${EDITABLE_OCCURRENCE}`).get(recurrenceId, from)
    const kept = sqlite.prepare(`SELECT COUNT(*) AS c FROM scheduled_shifts
      WHERE recurrence_id = ? AND deleted_at IS NULL AND NOT (status = 'scheduled'
        AND clock_in_at IS NULL AND scheduled_date >= ?)`).get(recurrenceId, from)
    return { upcoming_count: up.c, kept_count: kept.c, next_date: up.next || null }
  }

  /** Attach the occurrence counts a series-management UI needs to a series. */
  function withCounts (rec) {
    return rec ? { ...rec, ...occurrenceSummary(rec.id) } : rec
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

  // Series rows carry the participant and assigned-worker labels a management UI
  // needs, so a series can be identified without a second round-trip.
  const SERIES_SELECT = `SELECT r.*, c.preferred_name AS client_preferred_name,
      c.first_name AS client_first_name, c.last_name AS client_last_name, bc.code AS billing_code,
      u.display_name AS worker_display_name, u.username AS worker_username
    FROM shift_recurrences r JOIN clients c ON c.id = r.client_id
    LEFT JOIN billing_codes bc ON bc.id = r.billing_code_id
    LEFT JOIN users u ON u.id = r.worker_id`

  /** Decrypt a joined series row and resolve its display labels + counts. */
  function toSeries (row) {
    const r = withCounts(toRecurrence(row))
    r.client_display_name = clientDisplayName(row)
    r.worker_display_name = row.worker_display_name || row.worker_username || null
    delete r.client_first_name
    delete r.client_last_name
    delete r.worker_username
    return r
  }

  /**
   * List recurrence series. This is what backs the "repeating appointments"
   * list, where a series is edited or ended as a whole rather than one
   * materialised occurrence at a time. Active series sort first.
   */
  function listRecurrences () {
    return sqlite.prepare(`${SERIES_SELECT} WHERE r.deleted_at IS NULL
      ORDER BY r.active DESC, r.created_at DESC`).all().map(toSeries)
  }

  /** Fetch one series (decrypted, with labels + occurrence counts) or throw 404. */
  function getRecurrence (id) {
    const row = sqlite.prepare(`${SERIES_SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Recurring appointment not found')
    return toSeries(row)
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
   * Update a series — the "edit them all" path. Every future un-started
   * occurrence is regenerated from the new rule (so a changed time, location,
   * support item, participant-facing title or assigned worker lands on all of
   * them at once); past, in-progress, completed and individually cancelled
   * occurrences are history and are left untouched.
   * @param {number} id
   * @param {object} data validated partial payload
   * @param {number} [actingUserId] fallback owner when `worker_id` is cleared
   * @returns {object} the updated series, with `occurrences_replaced`/`occurrences_created`
   */
  function updateRecurrence (id, data, actingUserId) {
    const before = getRecurrence(id)
    const sets = []
    const params = []
    for (const col of UPDATABLE) {
      if (!(col in data)) continue
      if (col === 'weekdays') { sets.push('weekdays = ?'); params.push(data.weekdays ? JSON.stringify(data.weekdays) : null); continue }
      if (col === 'plan_notes') { sets.push('plan_notes = ?'); params.push(encrypt(data.plan_notes ?? null)); continue }
      // worker_id is NOT NULL: clearing it re-rosters the series to the acting
      // admin (the single-operator default), never to NULL.
      if (col === 'worker_id') { sets.push('worker_id = ?'); params.push(data.worker_id || actingUserId || before.worker_id); continue }
      sets.push(`${col} = ?`)
      params.push(data[col] ?? null)
    }
    if (sets.length) {
      sets.push('updated_at = ?')
      params.push(now(), id)
      sqlite.prepare(`UPDATE shift_recurrences SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }
    const replaced = removeFutureOccurrences(id)
    const horizonEnd = fmt(addDays(parse(today()), HORIZON_DAYS))
    const rec = getRecurrence(id)
    const created = rec.active ? materialiseSeries(rec, horizonEnd) : 0
    // Only the occurrence counts moved under `rec`, so refresh those rather than
    // re-reading the whole series.
    return { ...rec, ...occurrenceSummary(id), occurrences_replaced: replaced, occurrences_created: created }
  }

  /**
   * Delete a series' not-yet-started occurrences from `from` onward (and their
   * mirrored calendar events). Worked, in-progress and cancelled occurrences are
   * never touched, so the roster history survives.
   * @param {number} recurrenceId
   * @param {string} [from] ISO date to cut from (defaults to today)
   * @returns {number} occurrences removed
   */
  function removeFutureOccurrences (recurrenceId, from = today()) {
    const rows = sqlite.prepare(`SELECT * FROM scheduled_shifts WHERE ${EDITABLE_OCCURRENCE}`)
      .all(recurrenceId, from)
    for (const row of rows) googleCalendar.removeScheduledShift(row)
    sqlite.prepare(`DELETE FROM scheduled_shifts WHERE ${EDITABLE_OCCURRENCE}`).run(recurrenceId, from)
    return rows.length
  }

  /**
   * Stop an open-ended series without erasing what it already produced — the
   * "delete the rest of them" path for an indefinite appointment. Caps the rule
   * at the day before `from`, drops every un-started occurrence from `from`
   * onward, and deactivates the series once nothing further can be generated.
   * @param {number} id
   * @param {string} [from] ISO date the series should stop repeating on (defaults to today)
   * @returns {object} the updated series, with `occurrences_removed`
   */
  function endRecurrence (id, from) {
    const rec = getRecurrence(id)
    const cut = from || today()
    const lastDay = fmt(addDays(parse(cut), -1))
    const removed = removeFutureOccurrences(id, cut)
    // Capping the rule is enough to stop it: an until_date before start_date
    // simply expands to no dates. Only deactivate once the cap is in the past —
    // a future cut-off must stay active so the nightly run keeps filling the
    // horizon up to it.
    const active = lastDay >= today() ? rec.active : 0
    sqlite.prepare('UPDATE shift_recurrences SET until_date = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(lastDay, active, now(), id)
    return { ...getRecurrence(id), occurrences_removed: removed }
  }

  /**
   * Soft-delete a series and remove its future un-started occurrences — the
   * "delete them all" path. History (started/completed/cancelled occurrences) is
   * retained, and the series stops materialising new ones.
   * @param {number} id
   * @returns {{deleted:boolean, occurrences_removed:number}}
   */
  function deleteRecurrence (id) {
    getRecurrence(id)
    const removed = removeFutureOccurrences(id)
    sqlite.prepare('UPDATE shift_recurrences SET deleted_at = ?, active = 0, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return { deleted: true, occurrences_removed: removed }
  }

  return {
    occurrenceDates,
    occurrenceSummary,
    materialiseDueOccurrences,
    listRecurrences,
    getRecurrence,
    createRecurrence,
    updateRecurrence,
    endRecurrence,
    deleteRecurrence
  }
}
