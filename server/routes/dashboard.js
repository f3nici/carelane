import { Router } from 'express'
import { sqlite } from '../db/connection.js'
import { recentActivity } from '../services/activityService.js'
import { clientDisplayName } from '../services/clientService.js'
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
  const soon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  res.json(ok({
    active_clients: get('SELECT COUNT(*) AS c FROM clients WHERE deleted_at IS NULL AND active = 1').c,
    agreements_active: get('SELECT COUNT(*) AS c FROM service_agreements WHERE deleted_at IS NULL AND archived_at IS NULL AND status = \'active\'').c,
    shifts_this_month: sqlite.prepare('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND shift_date >= ?')
      .get(today.slice(0, 8) + '01').c,
    unfinalised_notes: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND finalised = 0').c,
    unbilled_shifts: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND billed = 0 AND finalised = 1').c,
    open_incidents: get('SELECT COUNT(*) AS c FROM shift_notes WHERE deleted_at IS NULL AND archived_at IS NULL AND incident_flag = 1 AND follow_up_required = 1').c,
    plan_reviews_due: sqlite.prepare('SELECT COUNT(*) AS c FROM clients WHERE deleted_at IS NULL AND active = 1 AND plan_end IS NOT NULL AND plan_end BETWEEN ? AND ?').get(today, soon).c,
    upcoming_shifts: sqlite.prepare("SELECT COUNT(*) AS c FROM scheduled_shifts WHERE deleted_at IS NULL AND status IN ('scheduled','in_progress') AND scheduled_date >= ?").get(today).c,
    draft_reports: get('SELECT COUNT(*) AS c FROM reports WHERE deleted_at IS NULL AND archived_at IS NULL AND status = \'draft\'').c,
    documents_indexed: get('SELECT COUNT(*) AS c FROM documents WHERE indexed = 1').c
  }))
})

/** Clients whose plan review (plan_end) falls in the next 60 days. */
router.get('/plan-reviews', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const rows = sqlite.prepare(`SELECT id, preferred_name, first_name, last_name, suburb, plan_end FROM clients
    WHERE deleted_at IS NULL AND active = 1 AND plan_end IS NOT NULL AND plan_end BETWEEN ? AND ?
    ORDER BY plan_end`).all(today, soon)
  res.json(ok(rows.map(({ first_name, last_name, ...r }) => ({ ...r, client_display_name: clientDisplayName({ first_name, last_name, ...r }) }))))
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
