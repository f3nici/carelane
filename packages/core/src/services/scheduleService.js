import { ApiError } from '../errors.js'

/**
 * Build the scheduling/roster service bound to a host context. Google Calendar
 * mirroring is an optional server-only integration read lazily from
 * `ctx.googleCalendar`; when absent (e.g. in the app) it is a no-op.
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services
 */
export function createScheduleService (ctx, services) {
  const { sqlite } = ctx
  const { encrypt, decryptFields } = services.crypto
  const { clientDisplayName } = services.client
  const { createShift } = services.shift
  const { getSetting } = services.settings
  const googleCalendar = {
    syncScheduledShift: (...a) => ctx.googleCalendar?.syncScheduledShift?.(...a),
    removeScheduledShift: (...a) => ctx.googleCalendar?.removeScheduledShift?.(...a)
  }

  /**
   * Forward-looking roster of planned shifts. A scheduled shift moves
   * scheduled → in_progress (clock-in) → completed (clock-out + note), or can be
   * cancelled. The note created at clock-out is a normal shift_note, linked back
   * via shift_note_id. plan_notes is encrypted at rest like shift bodies, and each
   * change is mirrored to Google Calendar (best-effort, no-op when disabled).
   */

  const ENCRYPTED = ['plan_notes']
  const COLUMNS = ['client_id', 'title', 'scheduled_date', 'start_time', 'end_time',
    'billing_code_id', 'location', 'plan_notes']
  const STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled']

  const now = () => new Date(ctx.now()).toISOString()
  /**
   * HH:MM for an ISO timestamp rendered in the operator's configured timezone
   * (shared with the calendar mirror) rather than the server's. Clock-in/out are
   * stored as UTC, so a UTC server would otherwise stamp notes with the wrong time.
   */
  const hhmm = iso => {
    if (!iso) return null
    const tz = getSetting('google_calendar_timezone', 'Australia/Perth')
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz
    }).format(new Date(iso))
  }

  function toScheduled (row) {
    return row ? decryptFields(row, ENCRYPTED) : null
  }

  function toScheduledListRow (row) {
    const s = toScheduled(row)
    s.client_display_name = clientDisplayName(row)
    delete s.client_first_name
    delete s.client_last_name
    return s
  }

  /**
   * List scheduled shifts within an optional date range / client / status filter.
   * Deleted rows are always excluded. Ordered chronologically for the calendar.
   * @param {{from?:string, to?:string, client_id?:string, status?:string}} filters
   */
  function listScheduled (filters = {}) {
    const where = ['s.deleted_at IS NULL']
    const params = []
    if (filters.from) { where.push('s.scheduled_date >= ?'); params.push(filters.from) }
    if (filters.to) { where.push('s.scheduled_date <= ?'); params.push(filters.to) }
    if (filters.client_id) { where.push('s.client_id = ?'); params.push(Number(filters.client_id)) }
    if (filters.status && STATUSES.includes(filters.status)) { where.push('s.status = ?'); params.push(filters.status) }
    const rows = sqlite.prepare(`SELECT s.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name, bc.code AS billing_code
      FROM scheduled_shifts s
      JOIN clients c ON c.id = s.client_id AND c.deleted_at IS NULL
      LEFT JOIN billing_codes bc ON bc.id = s.billing_code_id
      WHERE ${where.join(' AND ')} ORDER BY s.scheduled_date, s.start_time, s.id`).all(...params)
    return rows.map(toScheduledListRow)
  }

  /** Fetch one scheduled shift (decrypted) or throw 404. */
  function getScheduled (id) {
    const row = sqlite.prepare('SELECT * FROM scheduled_shifts WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Scheduled shift not found')
    return toScheduled(row)
  }

  /** Internal: fetch the raw (still-encrypted) row, used for Google sync. */
  function rawRow (id) {
    return sqlite.prepare('SELECT * FROM scheduled_shifts WHERE id = ?').get(id)
  }

  /**
   * Create a one-off scheduled shift and mirror it to Google Calendar.
   * @param {object} data validated payload
   * @param {number} workerId
   */
  function createScheduled (data, workerId) {
    const ts = now()
    const cols = [...COLUMNS, 'worker_id', 'status', 'created_at', 'updated_at']
    const values = COLUMNS.map(c => (ENCRYPTED.includes(c) ? encrypt(data[c] ?? null) : (data[c] ?? null)))
    const id = sqlite.prepare(`INSERT INTO scheduled_shifts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values, workerId, 'scheduled', ts, ts).lastInsertRowid
    googleCalendar.syncScheduledShift(rawRow(id))
    return getScheduled(id)
  }

  /**
   * Update a scheduled shift's plan. Completed/cancelled shifts are not editable
   * here. Re-syncs the Google event.
   * @param {number} id
   * @param {object} data
   */
  function updateScheduled (id, data) {
    const existing = getScheduled(id)
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      throw new ApiError(409, 'NOT_EDITABLE', `A ${existing.status} shift cannot be edited`)
    }
    const sets = []
    const params = []
    for (const col of COLUMNS) {
      if (!(col in data) || col === 'client_id') continue
      sets.push(`${col} = ?`)
      params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
    }
    if (sets.length) {
      sets.push('updated_at = ?')
      params.push(now(), id)
      sqlite.prepare(`UPDATE scheduled_shifts SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      googleCalendar.syncScheduledShift(rawRow(id))
    }
    return getScheduled(id)
  }

  /**
   * Clock in to a scheduled shift. Records the start timestamp and flips the
   * status to in_progress. Idempotent if already in progress.
   * @param {number} id
   */
  function clockIn (id) {
    const shift = getScheduled(id)
    if (shift.status === 'completed' || shift.status === 'cancelled') {
      throw new ApiError(409, 'BAD_STATE', `Cannot clock in to a ${shift.status} shift`)
    }
    if (!shift.clock_in_at) {
      sqlite.prepare("UPDATE scheduled_shifts SET clock_in_at = ?, status = 'in_progress', updated_at = ? WHERE id = ?")
        .run(now(), now(), id)
    }
    return getScheduled(id)
  }

  /**
   * Clock out of an in-progress shift. Records the end timestamp and marks the
   * shift completed; the caller is then prompted to create the linked note.
   * @param {number} id
   */
  function clockOut (id) {
    const shift = getScheduled(id)
    if (shift.status !== 'in_progress' || !shift.clock_in_at) {
      throw new ApiError(409, 'BAD_STATE', 'Clock in before clocking out')
    }
    sqlite.prepare("UPDATE scheduled_shifts SET clock_out_at = ?, status = 'completed', updated_at = ? WHERE id = ?")
      .run(now(), now(), id)
    return getScheduled(id)
  }

  /**
   * Build the prefilled shift-note payload for a (clocked-out) scheduled shift:
   * actual clock times when present, otherwise the planned times.
   * @param {number} id
   */
  function notePrefill (id) {
    const shift = getScheduled(id)
    return {
      client_id: shift.client_id,
      shift_date: shift.scheduled_date,
      start_time: hhmm(shift.clock_in_at) || shift.start_time,
      end_time: hhmm(shift.clock_out_at) || shift.end_time,
      billing_code_id: shift.billing_code_id,
      location: shift.location,
      scheduled_shift_id: shift.id,
      already_noted: !!shift.shift_note_id
    }
  }

  /**
   * Create the shift note for a scheduled shift and link the two. The participant,
   * date and times come from the scheduled shift (actual clock times preferred);
   * the operator supplies the narrative fields.
   * @param {number} id
   * @param {object} noteData validated note fields
   * @param {number} workerId
   */
  function createNoteFromShift (id, noteData, workerId) {
    const shift = getScheduled(id)
    if (shift.shift_note_id) throw new ApiError(409, 'ALREADY_NOTED', 'This shift already has a note')
    const prefill = notePrefill(id)
    const note = createShift({
      client_id: prefill.client_id,
      // The operator may correct the date/times before saving — honour their
      // values, falling back to the clocked (prefilled) ones.
      shift_date: noteData.shift_date ?? prefill.shift_date,
      start_time: noteData.start_time ?? prefill.start_time,
      end_time: noteData.end_time ?? prefill.end_time,
      billing_code_id: noteData.billing_code_id ?? prefill.billing_code_id,
      location: noteData.location ?? prefill.location,
      support_provided: noteData.support_provided ?? null,
      body: noteData.body ?? null,
      participant_response: noteData.participant_response ?? null,
      incident_flag: noteData.incident_flag ?? 0,
      incident_details: noteData.incident_details ?? null,
      follow_up_required: noteData.follow_up_required ?? 0,
      billed: 0,
      finalised: 0
    }, workerId)
    sqlite.prepare("UPDATE scheduled_shifts SET shift_note_id = ?, status = 'completed', updated_at = ? WHERE id = ?")
      .run(note.id, now(), id)
    return { scheduled: getScheduled(id), note }
  }

  /**
   * Cancel a scheduled shift (keeps the row, removes the Google event). Cannot
   * cancel one that is already completed.
   * @param {number} id
   */
  function cancelScheduled (id) {
    const shift = getScheduled(id)
    if (shift.status === 'completed') throw new ApiError(409, 'BAD_STATE', 'A completed shift cannot be cancelled')
    sqlite.prepare("UPDATE scheduled_shifts SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), id)
    googleCalendar.removeScheduledShift(rawRow(id))
    return getScheduled(id)
  }

  /**
   * Soft-delete a scheduled shift and remove its Google event. The linked note (if
   * any) is a regulated record and is left untouched.
   * @param {number} id
   */
  function deleteScheduled (id) {
    getScheduled(id)
    googleCalendar.removeScheduledShift(rawRow(id))
    sqlite.prepare('UPDATE scheduled_shifts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Restore a soft-deleted scheduled shift (used by the Deleted Items view).
   * @param {number} id
   */
  function restoreScheduled (id) {
    const row = sqlite.prepare('SELECT id FROM scheduled_shifts WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted scheduled shift not found')
    sqlite.prepare('UPDATE scheduled_shifts SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    googleCalendar.syncScheduledShift(rawRow(id))
    return getScheduled(id)
  }

  /**
   * Upcoming shifts for the dashboard (next N days, not completed/cancelled) plus
   * any shift currently clocked in.
   * @param {number} [days]
   */
  function upcomingScheduled (days = 14) {
    const today = new Date(ctx.now()).toISOString().slice(0, 10)
    const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    return listScheduled({ from: today, to }).filter(s => s.status === 'scheduled' || s.status === 'in_progress')
  }

  /** The single shift currently in progress (clocked in, not out), if any. */
  function activeShift () {
    const row = sqlite.prepare("SELECT * FROM scheduled_shifts WHERE status = 'in_progress' AND deleted_at IS NULL ORDER BY clock_in_at DESC LIMIT 1").get()
    if (!row) return null
    return toScheduledListRow(sqlite.prepare(`SELECT s.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name FROM scheduled_shifts s
      JOIN clients c ON c.id = s.client_id WHERE s.id = ?`).get(row.id))
  }

  return {
    listScheduled,
    getScheduled,
    createScheduled,
    updateScheduled,
    clockIn,
    clockOut,
    notePrefill,
    createNoteFromShift,
    cancelScheduled,
    deleteScheduled,
    restoreScheduled,
    upcomingScheduled,
    activeShift
  }
}
