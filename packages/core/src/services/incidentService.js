import { ApiError } from '../errors.js'

/**
 * Build the incident-report service (CRUD + lifecycle + markdown) bound to a
 * host context. PDF *rendering* stays server-side; `buildIncidentMarkdown` here
 * produces the portable body it renders from.
 * @param {import('./index.js').CoreContext} ctx
 * @param {object} services assembled core services
 */
export function createIncidentService (ctx, services) {
  const { sqlite } = ctx
  const { encrypt, decryptFields } = services.crypto
  const { clientDisplayName, getClient } = services.client
  const { getShift } = services.shift

  // Narrative fields encrypted at rest (like shift bodies). The categorical
  // columns stay plain so the register can be listed and filtered.
  const ENCRYPTED = ['description', 'immediate_actions', 'persons_involved', 'witnesses',
    'injuries', 'contributing_factors', 'notified_parties', 'follow_up_actions']
  const COLUMNS = ['client_id', 'shift_note_id', 'reference_no', 'incident_date', 'incident_time',
    'location', 'incident_type', 'severity', 'reportable', 'reportable_category',
    'description', 'immediate_actions', 'persons_involved', 'witnesses', 'injuries',
    'contributing_factors', 'reported_to_ndis', 'reported_to_ndis_date', 'notified_parties',
    'follow_up_actions', 'follow_up_due_date', 'status']

  const now = () => new Date(ctx.now()).toISOString()

  /** Decrypt the narrative fields of an incident row. */
  function toIncident (row) {
    return row ? decryptFields(row, ENCRYPTED) : null
  }

  /**
   * Map a list-query row: derive the participant display name and drop the raw
   * legal-name columns. Narrative fields are not selected in list queries.
   */
  function toListRow (row) {
    const out = { ...row, client_display_name: clientDisplayName(row) }
    delete out.client_first_name
    delete out.client_last_name
    return out
  }

  /**
   * List incident reports with optional client / status / reportable filters.
   * @param {{page:number, perPage:number, offset:number}} pg
   * @param {{client_id?:string, status?:string, reportable?:string, shift_note_id?:string}} filters
   * @returns {{rows:object[], total:number}}
   */
  function listIncidents (pg, filters = {}) {
    const where = ['i.deleted_at IS NULL']
    const params = []
    if (filters.client_id) { where.push('i.client_id = ?'); params.push(Number(filters.client_id)) }
    if (filters.shift_note_id) { where.push('i.shift_note_id = ?'); params.push(Number(filters.shift_note_id)) }
    if (filters.status && ['open', 'in_progress', 'closed'].includes(filters.status)) { where.push('i.status = ?'); params.push(filters.status) }
    if (filters.reportable === 'true') where.push('i.reportable = 1')
    const whereSql = 'WHERE ' + where.join(' AND ')
    const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM incident_reports i
      JOIN clients c ON c.id = i.client_id AND c.deleted_at IS NULL ${whereSql}`).get(...params).c
    const rows = sqlite.prepare(`SELECT i.id, i.client_id, i.shift_note_id, i.reference_no, i.incident_date,
        i.incident_time, i.location, i.incident_type, i.severity, i.reportable, i.reportable_category,
        i.reported_to_ndis, i.follow_up_due_date, i.status, i.created_at, i.updated_at,
        c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
      FROM incident_reports i
      JOIN clients c ON c.id = i.client_id AND c.deleted_at IS NULL
      ${whereSql} ORDER BY i.incident_date DESC, i.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pg.perPage, pg.offset)
    return { rows: rows.map(toListRow), total }
  }

  /**
   * Fetch one incident report (decrypted) plus its participant display name, or
   * throw 404.
   * @param {number} id
   * @returns {object}
   */
  function getIncident (id) {
    const row = sqlite.prepare(`SELECT i.*, c.preferred_name AS client_preferred_name,
        c.first_name AS client_first_name, c.last_name AS client_last_name
      FROM incident_reports i JOIN clients c ON c.id = i.client_id
      WHERE i.id = ? AND i.deleted_at IS NULL`).get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Incident report not found')
    const incident = toIncident(row)
    incident.client_display_name = clientDisplayName(row)
    delete incident.client_first_name
    delete incident.client_last_name
    return incident
  }

  // NOT NULL columns with a DB default — coerce a missing value to a safe default
  // so direct inserts (e.g. promoting a shift) don't depend on Zod having run.
  const DEFAULTS = { incident_type: 'other', severity: 'minor', reportable: 0, reported_to_ndis: 0, status: 'open' }

  /** INSERT helper shared by create/createFromShift. */
  function insert (data, workerId) {
    const ts = now()
    const cols = [...COLUMNS, 'worker_id', 'created_at', 'updated_at']
    const closed = data.status === 'closed'
    const values = COLUMNS.map(c => {
      const v = data[c] ?? DEFAULTS[c] ?? null
      return ENCRYPTED.includes(c) ? encrypt(v) : v
    })
    const result = sqlite.prepare(`INSERT INTO incident_reports (${cols.join(', ')}, closed_at)
      VALUES (${cols.map(() => '?').join(', ')}, ?)`)
      .run(...values, workerId, ts, ts, closed ? ts : null)
    return getIncident(result.lastInsertRowid)
  }

  /**
   * Create an incident report.
   * @param {object} data validated payload
   * @param {number} workerId
   * @returns {object}
   */
  function createIncident (data, workerId) {
    getClient(data.client_id)
    return insert(data, workerId)
  }

  /**
   * Promote an incident-flagged shift note into a structured incident report,
   * prefilling the date/location and seeding the description from the note's
   * free-text incident details. Throws 409 if the note already has a report or is
   * not incident-flagged.
   * @param {number} shiftId
   * @param {number} workerId
   * @returns {object}
   */
  function createFromShift (shiftId, workerId) {
    const shift = getShift(shiftId)
    if (!shift.incident_flag) throw new ApiError(409, 'NOT_INCIDENT', 'This shift note is not flagged as an incident')
    const existing = sqlite.prepare('SELECT id FROM incident_reports WHERE shift_note_id = ? AND deleted_at IS NULL').get(shiftId)
    if (existing) throw new ApiError(409, 'ALREADY_PROMOTED', 'An incident report already exists for this shift note', { incident_id: existing.id })
    return insert({
      client_id: shift.client_id,
      shift_note_id: shiftId,
      incident_date: shift.shift_date,
      incident_time: shift.start_time || null,
      location: shift.location || null,
      incident_type: 'other',
      severity: 'minor',
      reportable: 0,
      description: shift.incident_details || null,
      status: 'open'
    }, workerId)
  }

  /**
   * Update an incident report (partial). Maintains closed_at when the status
   * transitions in/out of 'closed'.
   * @param {number} id
   * @param {object} data
   * @returns {object}
   */
  function updateIncident (id, data) {
    const existing = getIncident(id)
    const sets = []
    const params = []
    for (const col of COLUMNS) {
      if (!(col in data) || col === 'client_id') continue
      sets.push(`${col} = ?`)
      params.push(ENCRYPTED.includes(col) ? encrypt(data[col] ?? null) : (data[col] ?? null))
    }
    if ('status' in data && data.status !== existing.status) {
      sets.push('closed_at = ?')
      params.push(data.status === 'closed' ? now() : null)
    }
    if (!sets.length) return existing
    sets.push('updated_at = ?')
    params.push(now(), id)
    sqlite.prepare(`UPDATE incident_reports SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return getIncident(id)
  }

  /**
   * Soft-delete an incident report (regulated record — never hard-deleted).
   * @param {number} id
   */
  function deleteIncident (id) {
    getIncident(id)
    sqlite.prepare('UPDATE incident_reports SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Restore a soft-deleted incident report (Deleted-items recycle bin).
   * @param {number} id
   * @returns {object}
   */
  function restoreIncident (id) {
    const row = sqlite.prepare('SELECT id FROM incident_reports WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted incident report not found')
    sqlite.prepare('UPDATE incident_reports SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getIncident(id)
  }

  /** Count incident reports still needing follow-up (open or in progress). */
  function countOpenIncidents () {
    return sqlite.prepare("SELECT COUNT(*) AS c FROM incident_reports WHERE deleted_at IS NULL AND status IN ('open','in_progress')").get().c
  }

  /** Count reportable incidents not yet marked reported to the NDIS Commission. */
  function countUnreportedReportable () {
    return sqlite.prepare('SELECT COUNT(*) AS c FROM incident_reports WHERE deleted_at IS NULL AND reportable = 1 AND reported_to_ndis = 0').get().c
  }

  /**
   * Incident reports still needing follow-up, newest first, for the dashboard.
   * Narrative fields are not included (the list is a register, not the full file).
   * @returns {object[]}
   */
  function listOpenIncidents () {
    const rows = sqlite.prepare(`SELECT i.id, i.client_id, i.incident_date, i.incident_type, i.severity,
        i.reportable, i.reported_to_ndis, i.follow_up_due_date, i.status,
        c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
      FROM incident_reports i JOIN clients c ON c.id = i.client_id AND c.deleted_at IS NULL
      WHERE i.deleted_at IS NULL AND i.status IN ('open','in_progress')
      ORDER BY (i.follow_up_due_date IS NULL), i.follow_up_due_date, i.incident_date DESC`).all()
    return rows.map(toListRow)
  }

  const TYPE_LABELS = {
    injury: 'Injury', illness: 'Illness/medical', medication_error: 'Medication error',
    behaviour: 'Behaviour of concern', property_damage: 'Property damage',
    abuse_neglect: 'Abuse / neglect', restrictive_practice: 'Restrictive practice',
    death: 'Death', absconding: 'Absconding / missing', other: 'Other'
  }
  const CATEGORY_LABELS = {
    death: 'Death of a person with disability',
    serious_injury: 'Serious injury of a person with disability',
    abuse_or_neglect: 'Abuse or neglect of a person with disability',
    unlawful_contact: 'Unlawful sexual or physical contact / assault',
    sexual_misconduct: 'Sexual misconduct against a person with disability',
    unauthorised_restrictive_practice: 'Unauthorised use of a restrictive practice'
  }

  /** Human label for an incident type. */
  const incidentTypeLabel = t => TYPE_LABELS[t] || t

  /**
   * Build a markdown body for the incident-report PDF export. Includes the full
   * (decrypted) record; the rendered PDF is served auth-gated and carries a
   * confidentiality footer like other participant exports.
   * @param {object} incident a decrypted incident (from getIncident)
   * @returns {string}
   */
  function buildIncidentMarkdown (incident) {
    const i = incident
    const yn = v => (v ? 'Yes' : 'No')
    const field = (label, value) => `**${label}:** ${value || '—'}`
    const lines = []
    lines.push('## Incident details')
    lines.push(field('Participant', i.client_display_name))
    lines.push(field('Reference', i.reference_no))
    lines.push(field('Date', i.incident_date + (i.incident_time ? ` ${i.incident_time}` : '')))
    lines.push(field('Location', i.location))
    lines.push(field('Type', TYPE_LABELS[i.incident_type] || i.incident_type))
    lines.push(field('Severity', i.severity))
    lines.push('')
    lines.push('## NDIS reportable status')
    lines.push(field('Reportable incident', yn(i.reportable)))
    if (i.reportable) lines.push(field('Category', CATEGORY_LABELS[i.reportable_category] || i.reportable_category))
    lines.push(field('Reported to NDIS Commission', yn(i.reported_to_ndis)))
    if (i.reported_to_ndis_date) lines.push(field('Date reported', i.reported_to_ndis_date))
    lines.push('')
    lines.push('## What happened')
    lines.push(i.description || '—')
    if (i.injuries) { lines.push(''); lines.push('## Injuries'); lines.push(i.injuries) }
    if (i.persons_involved) { lines.push(''); lines.push('## Persons involved'); lines.push(i.persons_involved) }
    if (i.witnesses) { lines.push(''); lines.push('## Witnesses'); lines.push(i.witnesses) }
    if (i.immediate_actions) { lines.push(''); lines.push('## Immediate actions taken'); lines.push(i.immediate_actions) }
    if (i.contributing_factors) { lines.push(''); lines.push('## Contributing factors'); lines.push(i.contributing_factors) }
    if (i.notified_parties) { lines.push(''); lines.push('## Parties notified'); lines.push(i.notified_parties) }
    lines.push('')
    lines.push('## Follow-up')
    lines.push(field('Status', i.status))
    if (i.follow_up_due_date) lines.push(field('Follow-up due', i.follow_up_due_date))
    if (i.follow_up_actions) { lines.push(''); lines.push(i.follow_up_actions) }
    return lines.join('\n')
  }

  return {
    listIncidents,
    getIncident,
    createIncident,
    createFromShift,
    updateIncident,
    deleteIncident,
    restoreIncident,
    countOpenIncidents,
    countUnreportedReportable,
    listOpenIncidents,
    buildIncidentMarkdown,
    incidentTypeLabel
  }
}
