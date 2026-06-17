import { Router } from 'express'
import { sqlite } from '../db/connection.js'
import { recentActivity } from '../services/activityService.js'
import { clientDisplayName } from '../services/clientService.js'
import { listExpiringDocuments, countExpiringDocuments } from '../services/clientDocumentService.js'
import { countOpenIncidents, countUnreportedReportable, listOpenIncidents } from '../services/incidentService.js'
import { ok } from '../utils/pagination.js'

const router = Router()

/**
 * @openapi
 * /dashboard/stats:
 *   get: { tags: [Dashboard], summary: Headline counts for the dashboard }
 */
router.get('/stats', (req, res) => {
  const get = sql => sqlite.prepare(sql).get()
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  res.json(ok({
    active_clients: get('SELECT COUNT(*) AS c FROM clients WHERE deleted_at IS NULL AND active = 1').c,
    agreements_active: get('SELECT COUNT(*) AS c FROM service_agreements WHERE deleted_at IS NULL AND archived_at IS NULL AND status = \'active\'').c,
    shifts_this_month: sqlite.prepare('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND shift_date >= ?')
      .get(today.slice(0, 8) + '01').c,
    unfinalised_notes: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND finalised = 0').c,
    unbilled_shifts: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND billed = 0 AND finalised = 1').c,
    open_incidents: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND incident_flag = 1 AND follow_up_required = 1').c,
    agreements_expiring: sqlite.prepare("SELECT COUNT(*) AS c FROM service_agreements WHERE deleted_at IS NULL AND archived_at IS NULL AND status = 'active' AND end_date IS NOT NULL AND end_date BETWEEN ? AND ?").get(today, soon).c,
    upcoming_shifts: sqlite.prepare("SELECT COUNT(*) AS c FROM scheduled_shifts WHERE deleted_at IS NULL AND status IN ('scheduled','in_progress') AND scheduled_date >= ?").get(today).c,
    draft_reports: get('SELECT COUNT(*) AS c FROM reports WHERE deleted_at IS NULL AND archived_at IS NULL AND status = \'draft\'').c,
    documents_indexed: get('SELECT COUNT(*) AS c FROM documents WHERE indexed = 1').c,
    documents_expiring: countExpiringDocuments(90),
    open_incident_reports: countOpenIncidents(),
    reportable_unreported: countUnreportedReportable()
  }))
})

/**
 * @openapi
 * /dashboard/incident-followups:
 *   get: { tags: [Dashboard], summary: Incident reports still needing follow-up }
 */
router.get('/incident-followups', (req, res) => {
  res.json(ok(listOpenIncidents()))
})

/**
 * @openapi
 * /dashboard/document-expiries:
 *   get: { tags: [Dashboard], summary: Consent forms & documents expired or expiring within 90 days }
 */
router.get('/document-expiries', (req, res) => {
  res.json(ok(listExpiringDocuments(90)))
})

/** Active service agreements whose end_date falls in the next 90 days. */
router.get('/agreement-expiries', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const rows = sqlite.prepare(`SELECT a.id, a.title, a.end_date, a.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM service_agreements a JOIN clients c ON c.id = a.client_id
    WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND a.status = 'active'
      AND a.end_date IS NOT NULL AND a.end_date BETWEEN ? AND ?
    ORDER BY a.end_date`).all(today, soon)
  res.json(ok(rows.map(({ client_first_name, client_last_name, ...r }) => ({
    ...r,
    client_display_name: clientDisplayName({ first_name: client_first_name, last_name: client_last_name, preferred_name: r.client_preferred_name, id: r.client_id })
  }))))
})

/**
 * @openapi
 * /dashboard/activity:
 *   get: { tags: [Dashboard], summary: Recent audit-log activity (PII-redacted) }
 */
router.get('/activity', (req, res) => {
  res.json(ok(recentActivity(Math.min(100, Number(req.query.limit) || 25))))
})

export default router
