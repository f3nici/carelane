import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { ntfySettingsSchema } from '../utils/validators.js'
import { requireAdmin } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { updateSettings } from '../services/settingsService.js'
import { logActivity } from '../services/activityService.js'
import * as ntfy from '../services/ntfyService.js'
import { ok } from '../utils/pagination.js'

const router = Router()
// Cap on-demand outbound pushes (test / send-now) so they can't be hammered.
const outboundLimiter = rateLimit({ name: 'ntfy-out', max: 15, windowMs: 60 * 1000 })

// Map the settings-card field names to their `ntfy_*` settings keys.
const SETTING_KEYS = {
  enabled: 'ntfy_enabled',
  server_url: 'ntfy_server_url',
  topic: 'ntfy_topic',
  priority: 'ntfy_priority',
  notify_plan_reviews: 'ntfy_notify_plan_reviews',
  notify_incidents: 'ntfy_notify_incidents',
  notify_unbilled: 'ntfy_notify_unbilled',
  notify_shift_reminders: 'ntfy_notify_shift_reminders',
  digest_time: 'ntfy_digest_time',
  plan_review_days: 'ntfy_plan_review_days',
  unbilled_days: 'ntfy_unbilled_days',
  shift_reminder_minutes: 'ntfy_shift_reminder_minutes'
}

/**
 * @openapi
 * /notifications/status:
 *   get: { tags: [Notifications], summary: ntfy push status, settings and a preview of pending nudges }
 */
router.get('/status', (req, res) => {
  res.json(ok(ntfy.status()))
})

/**
 * @openapi
 * /notifications/settings:
 *   put: { tags: [Notifications], summary: Update ntfy connection, toggles and timings (admin only) }
 */
router.put('/settings', requireAdmin, validate(ntfySettingsSchema), (req, res) => {
  const patch = {}
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    if (field in req.body) patch[key] = req.body[field]
  }
  if (Object.keys(patch).length) updateSettings(patch)
  logActivity('ntfy', null, req.session.userId, 'settings_updated', { keys: Object.keys(patch).join(',') })
  res.json(ok(ntfy.status()))
})

/**
 * @openapi
 * /notifications/test:
 *   post: { tags: [Notifications], summary: Send a test push to the configured topic (admin only) }
 */
router.post('/test', requireAdmin, outboundLimiter, async (req, res) => {
  const result = await ntfy.sendTest(req.session.userId)
  res.json(ok(result))
})

/**
 * @openapi
 * /notifications/send-now:
 *   post: { tags: [Notifications], summary: Push the attention-needed digest now (admin only) }
 */
router.post('/send-now', requireAdmin, outboundLimiter, async (req, res) => {
  const result = await ntfy.sendDigest('manual', req.session.userId)
  res.json(ok(result))
})

/** Clear the live error banner (the audit-log history is untouched). */
router.post('/clear-error', requireAdmin, (req, res) => {
  res.json(ok(ntfy.clearError()))
})

export default router
