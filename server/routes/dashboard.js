import { Router } from 'express'
import { sqlite } from '../db/connection.js'
import { recentActivity } from '../services/activityService.js'
import { clientDisplayName } from '../services/clientService.js'
import { agreementDueDate } from '../services/agreementService.js'
import { listExpiringDocuments, countExpiringDocuments } from '../services/clientDocumentService.js'
import { countOpenIncidents, countUnreportedReportable, listOpenIncidents } from '../services/incidentService.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * Build a `AND <col> IN (...)` fragment (with bound params) that scopes a
 * dashboard query to the caller's assigned participants. An admin
 * (`req.assignedClientIds === null`) gets an empty fragment (unrestricted); a
 * worker with no assignments gets `IN (0)`, which matches nothing since ids are
 * always positive.
 * @param {import('express').Request} req
 * @param {string} col client-id column (optionally table-aliased)
 * @returns {{sql:string, params:number[]}}
 */
function scope (req, col = 'client_id') {
  const ids = req.assignedClientIds
  if (ids === null) return { sql: '', params: [] }
  if (!ids.length) return { sql: `AND ${col} IN (0)`, params: [] }
  return { sql: `AND ${col} IN (${ids.map(() => '?').join(', ')})`, params: ids }
}

/** Participant-id list for the scoped service helpers (undefined = admin/all). */
const scopedIds = req => (req.isAdmin ? undefined : req.assignedClientIds)

/**
 * @openapi
 * /dashboard/stats:
 *   get: { tags: [Dashboard], summary: Headline counts for the dashboard (scoped to the caller's access) }
 */
router.get('/stats', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cs = scope(req)
  const idScope = scope(req, 'id')
  const count = (sql, params = []) => sqlite.prepare(sql).get(...params).c
  // Roster counts are scoped by owning worker (a worker sees only their own
  // shifts), participant-linked counts by assigned participant.
  const rosterScope = req.isAdmin ? { sql: '', params: [] } : { sql: 'AND worker_id = ?', params: [req.currentUser.id] }

  res.json(ok({
    active_clients: count(`SELECT COUNT(*) AS c FROM clients WHERE deleted_at IS NULL AND active = 1 ${idScope.sql}`, idScope.params),
    agreements_active: count(`SELECT COUNT(*) AS c FROM service_agreements WHERE deleted_at IS NULL AND archived_at IS NULL AND status = 'active' ${cs.sql}`, cs.params),
    shifts_this_month: count(`SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND shift_date >= ? ${cs.sql}`, [today.slice(0, 8) + '01', ...cs.params]),
    unfinalised_notes: count(`SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND finalised = 0 ${cs.sql}`, cs.params),
    unbilled_shifts: count(`SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND billed = 0 AND finalised = 1 ${cs.sql}`, cs.params),
    open_incidents: count(`SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND incident_flag = 1 AND follow_up_required = 1 ${cs.sql}`, cs.params),
    agreements_expiring: count(`SELECT COUNT(*) AS c FROM service_agreements
      WHERE deleted_at IS NULL AND archived_at IS NULL AND status = 'active'
        AND ((end_date IS NOT NULL AND end_date BETWEEN ? AND ?)
          OR (review_date IS NOT NULL AND review_date BETWEEN ? AND ?)) ${cs.sql}`, [today, soon, today, soon, ...cs.params]),
    upcoming_shifts: count(`SELECT COUNT(*) AS c FROM scheduled_shifts WHERE deleted_at IS NULL AND status IN ('scheduled','in_progress') AND scheduled_date >= ? ${rosterScope.sql}`, [today, ...rosterScope.params]),
    draft_reports: count(`SELECT COUNT(*) AS c FROM reports WHERE deleted_at IS NULL AND archived_at IS NULL AND status = 'draft' ${cs.sql}`, cs.params),
    // The knowledge base is an admin-only tool — workers see no indexed-doc count.
    documents_indexed: req.isAdmin ? count('SELECT COUNT(*) AS c FROM documents WHERE indexed = 1') : 0,
    documents_expiring: countExpiringDocuments(90, scopedIds(req)),
    open_incident_reports: countOpenIncidents(scopedIds(req)),
    reportable_unreported: countUnreportedReportable(scopedIds(req))
  }))
})

/**
 * @openapi
 * /dashboard/incident-followups:
 *   get: { tags: [Dashboard], summary: Incident reports still needing follow-up (scoped) }
 */
router.get('/incident-followups', (req, res) => {
  res.json(ok(listOpenIncidents(scopedIds(req))))
})

/**
 * @openapi
 * /dashboard/document-expiries:
 *   get: { tags: [Dashboard], summary: Consent forms & documents expired or expiring within 90 days (scoped) }
 */
router.get('/document-expiries', (req, res) => {
  res.json(ok(listExpiringDocuments(90, scopedIds(req))))
})

/** Active service agreements expiring (end date) or due for review in 90 days. */
router.get('/agreement-expiries', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cs = scope(req, 'a.client_id')
  const rows = sqlite.prepare(`SELECT a.id, a.title, a.end_date, a.review_date, a.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM service_agreements a JOIN clients c ON c.id = a.client_id
    WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND a.status = 'active'
      AND ((a.end_date IS NOT NULL AND a.end_date BETWEEN ? AND ?)
        OR (a.review_date IS NOT NULL AND a.review_date BETWEEN ? AND ?)) ${cs.sql}`).all(today, soon, today, soon, ...cs.params)
  const mapped = rows.map(({ client_first_name, client_last_name, ...r }) => ({
    ...r,
    ...agreementDueDate(r, today, soon),
    client_display_name: clientDisplayName({ first_name: client_first_name, last_name: client_last_name, preferred_name: r.client_preferred_name, id: r.client_id })
  }))
  // Soonest attention first (the triggering end/review date).
  mapped.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
  res.json(ok(mapped))
})

/**
 * @openapi
 * /dashboard/activity:
 *   get: { tags: [Dashboard], summary: Recent audit-log activity (admin only; PII-redacted) }
 */
router.get('/activity', (req, res) => {
  // The audit feed spans every participant, so it is an admin-only surface.
  if (!req.isAdmin) return res.json(ok([]))
  res.json(ok(recentActivity(Math.min(100, Number(req.query.limit) || 25))))
})

export default router
