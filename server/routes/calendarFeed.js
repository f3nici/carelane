import { Router } from 'express'
import { resolveUserByToken, buildFeed } from '../services/calendarFeedService.js'

/**
 * Public, unauthenticated iCal feed. Mounted at `/calendar`, OUTSIDE the
 * `/api/v1` session + CSRF stack, because a calendar client subscribes with a
 * bare URL and carries no cookie. The secret token in the path is the only
 * credential; an unknown/revoked token 404s. Read-only (GET), so there is no
 * state-changing action for CSRF to protect. See calendarFeedService for the
 * privacy note — events carry only a short label, never plan/health notes.
 */
const router = Router()

router.get('/:token.ics', (req, res) => {
  const user = resolveUserByToken(req.params.token)
  if (!user) return res.status(404).type('text/plain').send('Calendar feed not found')
  const body = buildFeed(user, req.get('host') || 'carelane')
  res.set('Content-Type', 'text/calendar; charset=utf-8')
  res.set('Content-Disposition', 'inline; filename="carelane-roster.ics"')
  // The URL embeds a secret and the body carries participant labels — keep it
  // out of any shared/intermediary cache. Calendar clients still re-poll on
  // their own schedule.
  res.set('Cache-Control', 'private, no-store')
  res.send(body)
})

export default router
