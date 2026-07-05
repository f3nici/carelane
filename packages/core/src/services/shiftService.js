import { ApiError } from '../errors.js'
import { applyClientScope } from '../utils/sql.js'

/**
 * Build the shift-note service bound to a host context.
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services (for crypto + client display names)
 */
export function createShiftService (ctx, services) {
  const { sqlite } = ctx
  const { encrypt, decryptFields, blindIndex } = services.crypto
  const { clientDisplayName } = services.client

  const ENCRYPTED = ['body', 'incident_details']
  const COLUMNS = ['client_id', 'shift_date', 'start_time', 'end_time', 'duration_hours',
    'billing_code_id', 'location', 'support_provided', 'body', 'participant_response',
    'incident_flag', 'incident_details', 'follow_up_required', 'billed', 'finalised']

  const now = () => new Date(ctx.now()).toISOString()

  function toShift (row) {
    return row ? decryptFields(row, ENCRYPTED) : null
  }

  /**
   * Map a list-query row: decrypt note fields, derive `client_display_name`, and
   * drop the raw joined legal-name columns so they don't leak into the response.
   */
  function toShiftListRow (row) {
    const shift = toShift(row)
    shift.client_display_name = clientDisplayName(row)
    delete shift.client_first_name
    delete shift.client_last_name
    return shift
  }

  /**
   * Compute duration in hours from HH:MM start/end times (overnight-safe),
   * rounded to the nearest quarter hour (0.25).
   */
  function computeDuration (start, end) {
    if (!start || !end) return null
    const [sh, sm] = start.split(':').map(Number)
    const [eh, em] = end.split(':').map(Number)
    let mins = (eh * 60 + em) - (sh * 60 + sm)
    if (mins <= 0) mins += 24 * 60
    return Math.round((mins / 60) * 4) / 4
  }

  // Note text that feeds the keyword search. `body`/`incident_details` are
  // encrypted at rest, so they are tokenised from the decrypted note here in the
  // app layer (never in a SQL trigger) and only a keyed per-word hash reaches the
  // FTS index — the plaintext is never written to the shadow table.
  const SEARCH_TEXT_FIELDS = ['body', 'incident_details', 'support_provided', 'participant_response', 'location']

  /** Split free text into lowercased, de-duplicated word tokens (min length 2). */
  function tokenizeText (text) {
    return [...new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1))]
  }

  /**
   * A per-word blind index: a truncated, keyed HMAC of one token. Reuses the
   * crypto blind-index key, so the FTS row never reveals the note's words; the
   * leading letter keeps every token a valid FTS5 bareword.
   */
  function searchToken (word) {
    return 't' + blindIndex(word).slice(0, 16)
  }

  /** Space-joined blind-index tokens for a shift's searchable text (its FTS row). */
  function indexTokens (shift) {
    const words = new Set()
    for (const f of SEARCH_TEXT_FIELDS) for (const w of tokenizeText(shift[f])) words.add(w)
    return [...words].map(searchToken).join(' ')
  }

  /**
   * FTS5 MATCH expression for a keyword query: every query word must be present
   * (AND). Returns null when the query has no indexable (>=2 char) token.
   */
  function searchMatch (q) {
    const tokens = tokenizeText(q).map(searchToken)
    return tokens.length ? tokens.join(' AND ') : null
  }

  /**
   * (Re)write a shift's blind-index row in the keyword FTS table. Called on every
   * create/update; a delete-then-insert keeps the row a self-contained FTS entry
   * (no external-content triggers to drift). Soft-delete/restore need not touch
   * the index — list queries already gate visibility on `deleted_at`.
   * @param {object} shift a decrypted shift note (from {@link getShift})
   */
  function indexShift (shift) {
    sqlite.prepare('DELETE FROM shift_notes_fts WHERE rowid = ?').run(shift.id)
    sqlite.prepare('INSERT INTO shift_notes_fts (rowid, tokens) VALUES (?, ?)').run(shift.id, indexTokens(shift))
  }

  /**
   * Backfill the keyword FTS index for any shift note missing a row — used once
   * by the migration when the index is first created, and self-healing on later
   * boots (a no-op when already in sync). Runs in a single transaction.
   * @returns {number} how many notes were (re)indexed
   */
  function reindexSearch () {
    const missing = sqlite.prepare('SELECT id FROM shift_notes WHERE id NOT IN (SELECT rowid FROM shift_notes_fts)').all()
    const run = sqlite.transaction(ids => {
      for (const { id } of ids) indexShift(toShift(sqlite.prepare('SELECT * FROM shift_notes WHERE id = ?').get(id)))
    })
    run(missing)
    return missing.length
  }

  /**
   * List shift notes with optional client / incident / billed / archived filters,
   * a date filter (exact `date`, or a `date_from`/`date_to` range), a free-text
   * `q` keyword search over the note body, incident details, support provided,
   * participant response and location, and a `sort` order (`date` newest-first —
   * the default, `date_asc` oldest-first, or `client` by participant name).
   *
   * By default archived notes are hidden; pass `archived: 'true'` for archived
   * only, or `archived: 'all'` for both.
   *
   * Keyword search runs against the blind-index FTS table (`shift_notes_fts`),
   * so it stays a paginated SQL query that scales — the note body is searched
   * without ever decrypting the whole table. Whole-word (case-insensitive)
   * matching only: a query word matches a note word, not an arbitrary substring.
   * Sorting by participant is the one path that still decrypts in JS, since the
   * legal name is encrypted (the FTS join first narrows the set when searching).
   * @param {{page:number, perPage:number, offset:number}} pg
   * @param {{client_id?:string, incident?:string, billed?:string, archived?:string, date?:string, date_from?:string, date_to?:string, q?:string, sort?:string}} filters
   */
  function listShifts (pg, filters = {}) {
    const where = ['s.deleted_at IS NULL']
    const params = []
    applyClientScope(where, params, 's.client_id', filters.client_ids)
    if (filters.archived === 'true' || filters.archived === '1') where.push('s.archived_at IS NOT NULL')
    else if (filters.archived !== 'all') where.push('s.archived_at IS NULL')
    if (filters.client_id) { where.push('s.client_id = ?'); params.push(Number(filters.client_id)) }
    if (filters.incident === 'true') where.push('s.incident_flag = 1')
    if (filters.billed === 'false') where.push('s.billed = 0')
    if (filters.date) { where.push('s.shift_date = ?'); params.push(filters.date) }
    if (filters.date_from) { where.push('s.shift_date >= ?'); params.push(filters.date_from) }
    if (filters.date_to) { where.push('s.shift_date <= ?'); params.push(filters.date_to) }

    // Keyword search joins the blind-index FTS table and matches on hashed
    // tokens. A query with no indexable token can never match, so return empty.
    let joinFts = ''
    if (filters.q?.trim()) {
      const match = searchMatch(filters.q)
      if (!match) return { rows: [], total: 0 }
      joinFts = 'JOIN shift_notes_fts ON shift_notes_fts.rowid = s.id'
      where.push('shift_notes_fts MATCH ?')
      params.push(match)
    }
    const whereSql = 'WHERE ' + where.join(' AND ')

    // Join clients (excluding soft-deleted ones) so the count matches the listed
    // rows — a soft-deleted participant's shifts drop out of active lists.
    const from = `FROM shift_notes s
      JOIN clients c ON c.id = s.client_id AND c.deleted_at IS NULL
      LEFT JOIN billing_codes bc ON bc.id = s.billing_code_id
      ${joinFts} ${whereSql}`
    const select = `SELECT s.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name, bc.code AS billing_code ${from}`

    // Participant sort: the legal name is encrypted, so sort in JS (over the
    // FTS-narrowed set when a keyword is present) rather than in SQL.
    if (filters.sort === 'client') {
      const rows = sqlite.prepare(select).all(...params).map(toShiftListRow)
      rows.sort((a, b) => a.client_display_name.localeCompare(b.client_display_name) ||
        b.shift_date.localeCompare(a.shift_date) || b.id - a.id)
      return { rows: rows.slice(pg.offset, pg.offset + pg.perPage), total: rows.length }
    }

    const order = filters.sort === 'date_asc' ? 'ASC' : 'DESC'
    const total = sqlite.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params).c
    const rows = sqlite.prepare(`${select} ORDER BY s.shift_date ${order}, s.id ${order} LIMIT ? OFFSET ?`)
      .all(...params, pg.perPage, pg.offset)
    return { rows: rows.map(toShiftListRow), total }
  }

  /**
   * Fetch one shift note (decrypted) with its photos, or throw 404.
   * @param {number} id
   */
  function getShift (id) {
    const row = sqlite.prepare('SELECT * FROM shift_notes WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Shift note not found')
    const shift = toShift(row)
    shift.photos = sqlite.prepare('SELECT id, original_name, mime_type, size_bytes, caption, created_at FROM shift_photos WHERE shift_note_id = ?').all(id)
    return shift
  }

  /**
   * Create a shift note attributed to the acting worker.
   * @param {object} data validated payload
   * @param {number} workerId
   */
  function createShift (data, workerId) {
    const ts = now()
    // Duration is purely derived from the times — never taken from the client.
    const duration = computeDuration(data.start_time, data.end_time)
    const cols = [...COLUMNS, 'worker_id', 'created_at', 'updated_at']
    const values = COLUMNS.map(c => {
      if (c === 'duration_hours') return duration
      const v = data[c] ?? null
      return ENCRYPTED.includes(c) ? encrypt(v) : v
    })
    const result = sqlite.prepare(`INSERT INTO shift_notes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values, workerId, ts, ts)
    const shift = getShift(result.lastInsertRowid)
    indexShift(shift)
    return shift
  }

  /**
   * Update a shift note. Finalised notes only allow billing status changes,
   * unless the update sends `finalised: 0` to reopen the note for editing.
   * @param {number} id
   * @param {object} data
   */
  function updateShift (id, data) {
    const existing = getShift(id)
    if (existing.finalised && data.finalised !== 0) {
      const allowed = new Set(['billed', 'finalised'])
      data = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)))
      if (!Object.keys(data).length) throw new ApiError(409, 'FINALISED', 'Shift note is finalised; only billing status can change')
    }
    // Duration is always derived from the times, never client-supplied.
    delete data.duration_hours
    const sets = []
    const params = []
    for (const col of COLUMNS) {
      if (!(col in data) || col === 'client_id') continue
      sets.push(`${col} = ?`)
      params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
    }
    // Recalculate the duration whenever either time changes, using the new value
    // where supplied and falling back to the existing one otherwise.
    if ('start_time' in data || 'end_time' in data) {
      const start = 'start_time' in data ? data.start_time : existing.start_time
      const end = 'end_time' in data ? data.end_time : existing.end_time
      sets.push('duration_hours = ?')
      params.push(computeDuration(start, end))
    }
    if (!sets.length) return existing
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE shift_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const shift = getShift(id)
    indexShift(shift)
    return shift
  }

  /**
   * Soft-delete a shift note. Incident-flagged notes cannot be deleted.
   * @param {number} id
   */
  function deleteShift (id) {
    const shift = getShift(id)
    if (shift.incident_flag) throw new ApiError(409, 'INCIDENT_RETAINED', 'Incident-flagged shift notes cannot be deleted')
    sqlite.prepare('UPDATE shift_notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Archive a shift note (hide it from active lists without deleting it).
   * @param {number} id
   */
  function archiveShift (id) {
    getShift(id)
    sqlite.prepare('UPDATE shift_notes SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return getShift(id)
  }

  /**
   * Unarchive a shift note (return it to the active list).
   * @param {number} id
   */
  function unarchiveShift (id) {
    getShift(id)
    sqlite.prepare('UPDATE shift_notes SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getShift(id)
  }

  /**
   * Restore a soft-deleted shift note. Throws 404 if it does not exist or is not
   * currently deleted.
   * @param {number} id
   */
  function restoreShift (id) {
    const row = sqlite.prepare('SELECT id FROM shift_notes WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted shift note not found')
    sqlite.prepare('UPDATE shift_notes SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getShift(id)
  }

  /**
   * Attach an uploaded photo record to a shift note.
   * @param {number} shiftId
   * @param {{filename:string, originalname:string, mimetype:string, size:number}} file multer file
   * @param {string} [caption]
   */
  function addPhoto (shiftId, file, caption) {
    getShift(shiftId)
    const result = sqlite.prepare(`INSERT INTO shift_photos (shift_note_id, filename, original_name, mime_type, size_bytes, caption, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(shiftId, file.filename, file.originalname, file.mimetype, file.size, caption ?? null, now())
    return sqlite.prepare('SELECT id, original_name, mime_type, size_bytes, caption, created_at FROM shift_photos WHERE id = ?').get(result.lastInsertRowid)
  }

  /**
   * Fetch a photo row (incl. disk filename) ensuring it belongs to the shift.
   * @param {number} shiftId
   * @param {number} photoId
   */
  function getPhoto (shiftId, photoId) {
    const photo = sqlite.prepare('SELECT * FROM shift_photos WHERE id = ? AND shift_note_id = ?').get(photoId, shiftId)
    if (!photo) throw new ApiError(404, 'NOT_FOUND', 'Photo not found')
    return photo
  }

  /**
   * Delete a photo record (the row only; caller removes the file).
   * @param {number} shiftId
   * @param {number} photoId
   */
  function deletePhoto (shiftId, photoId) {
    const photo = getPhoto(shiftId, photoId)
    sqlite.prepare('DELETE FROM shift_photos WHERE id = ?').run(photoId)
    return photo
  }

  return {
    listShifts,
    reindexSearch,
    getShift,
    createShift,
    updateShift,
    deleteShift,
    archiveShift,
    unarchiveShift,
    restoreShift,
    addPhoto,
    getPhoto,
    deletePhoto
  }
}
