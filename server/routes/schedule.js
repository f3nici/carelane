import { Router } from 'express'
import crypto from 'node:crypto'
import { validate, validatePartial } from '../middleware/validate.js'
import { scheduledShiftSchema, recurrenceSchema, scheduleNoteSchema, googleSettingsSchema } from '../utils/validators.js'
import * as scheduleService from '../services/scheduleService.js'
import * as recurrenceService from '../services/recurrenceService.js'
import * as googleCalendar from '../services/googleCalendarService.js'
import { updateSettings } from '../services/settingsService.js'
import { logActivity, diffChanges } from '../services/activityService.js'
import { ok } from '../utils/pagination.js'
import { ApiError } from '../middleware/errorHandler.js'

const router = Router()
const id = req => Number(req.params.id)

/**
 * @openapi
 * /schedule:
 *   get: { tags: [Schedule], summary: List scheduled shifts (calendar/roster), filter by date range }
 *   post: { tags: [Schedule], summary: Create a one-off scheduled shift }
 */
router.get('/', (req, res) => {
  res.json(ok(scheduleService.listScheduled(req.query)))
})

router.post('/', validate(scheduledShiftSchema), (req, res) => {
  const shift = scheduleService.createScheduled(req.body, req.session.userId)
  logActivity('scheduled_shift', shift.id, req.session.userId, 'created', { date: shift.scheduled_date })
  res.status(201).json(ok(shift))
})

/** Upcoming shifts and the currently clocked-in shift, for the dashboard. */
router.get('/upcoming', (req, res) => {
  res.json(ok({
    upcoming: scheduleService.upcomingScheduled(Number(req.query.days) || 14),
    active: scheduleService.activeShift()
  }))
})

/* ---- Recurring appointments (defined before /:id) ---- */

/**
 * @openapi
 * /schedule/recurrences:
 *   get: { tags: [Schedule], summary: List recurring-appointment series }
 *   post: { tags: [Schedule], summary: Create a recurring-appointment series }
 */
router.get('/recurrences', (req, res) => {
  res.json(ok(recurrenceService.listRecurrences()))
})

router.post('/recurrences', validate(recurrenceSchema), (req, res) => {
  const rec = recurrenceService.createRecurrence(req.body, req.session.userId)
  logActivity('shift_recurrence', rec.id, req.session.userId, 'created', { frequency: rec.frequency })
  res.status(201).json(ok(rec))
})

router.get('/recurrences/:id', (req, res) => {
  res.json(ok(recurrenceService.getRecurrence(id(req))))
})

router.put('/recurrences/:id', validatePartial(recurrenceSchema), (req, res) => {
  const rec = recurrenceService.updateRecurrence(id(req), req.body)
  logActivity('shift_recurrence', rec.id, req.session.userId, 'updated', { changes: Object.keys(req.body) })
  res.json(ok(rec))
})

router.delete('/recurrences/:id', (req, res) => {
  recurrenceService.deleteRecurrence(id(req))
  logActivity('shift_recurrence', id(req), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/* ---- Google Calendar connection (defined before /:id) ---- */

/**
 * @openapi
 * /schedule/google/status:
 *   get: { tags: [Schedule], summary: Google Calendar connection status }
 */
router.get('/google/status', (req, res) => {
  res.json(ok(googleCalendar.status()))
})

/** Begin OAuth: returns the Google consent URL and stashes a CSRF state. */
router.get('/google/connect', (req, res, next) => {
  try {
    const state = crypto.randomBytes(16).toString('hex')
    req.session.googleOauthState = state
    res.json(ok({ url: googleCalendar.getAuthUrl(state) }))
  } catch (err) { next(new ApiError(400, 'GOOGLE_NOT_CONFIGURED', err.message)) }
})

/** OAuth redirect target. Verifies state, stores the token, returns to settings. */
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query
  if (!code || !state || state !== req.session.googleOauthState) {
    return res.redirect('/settings?google=error')
  }
  delete req.session.googleOauthState
  try {
    await googleCalendar.handleCallback(String(code))
    logActivity('google_calendar', null, req.session.userId, 'connected')
    res.redirect('/settings?google=connected')
  } catch {
    res.redirect('/settings?google=error')
  }
})

/** Live health check: confirm the stored credentials can reach the calendar. */
router.post('/google/test', async (req, res) => {
  const result = await googleCalendar.testConnection()
  logActivity('google_calendar', null, req.session.userId, 'tested', { ok: result.ok })
  res.json(ok(result))
})

router.post('/google/disconnect', (req, res) => {
  googleCalendar.disconnect()
  logActivity('google_calendar', null, req.session.userId, 'disconnected')
  res.json(ok(googleCalendar.status()))
})

router.put('/google/settings', validate(googleSettingsSchema), (req, res) => {
  const patch = {}
  if ('enabled' in req.body) patch.google_calendar_enabled = req.body.enabled
  if ('calendar_id' in req.body) patch.google_calendar_id = req.body.calendar_id
  if ('timezone' in req.body) patch.google_calendar_timezone = req.body.timezone
  updateSettings(patch)
  logActivity('google_calendar', null, req.session.userId, 'updated', { keys: Object.keys(patch) })
  res.json(ok(googleCalendar.status()))
})

/* ---- Single scheduled shift ---- */

router.get('/:id', (req, res) => {
  res.json(ok(scheduleService.getScheduled(id(req))))
})

router.put('/:id', validatePartial(scheduledShiftSchema), (req, res) => {
  const before = scheduleService.getScheduled(id(req))
  const shift = scheduleService.updateScheduled(id(req), req.body)
  logActivity('scheduled_shift', shift.id, req.session.userId, 'updated', {
    changes: diffChanges(before, shift, Object.keys(req.body))
  })
  res.json(ok(shift))
})

router.delete('/:id', (req, res) => {
  scheduleService.deleteScheduled(id(req))
  logActivity('scheduled_shift', id(req), req.session.userId, 'deleted')
  res.json(ok({ deleted: true }))
})

/**
 * @openapi
 * /schedule/{id}/cancel:
 *   post: { tags: [Schedule], summary: Cancel a scheduled shift }
 */
router.post('/:id/cancel', (req, res) => {
  const shift = scheduleService.cancelScheduled(id(req))
  logActivity('scheduled_shift', shift.id, req.session.userId, 'cancelled')
  res.json(ok(shift))
})

/**
 * @openapi
 * /schedule/{id}/clock-in:
 *   post: { tags: [Schedule], summary: Clock in to a scheduled shift }
 */
router.post('/:id/clock-in', (req, res) => {
  const shift = scheduleService.clockIn(id(req))
  logActivity('scheduled_shift', shift.id, req.session.userId, 'clocked_in')
  res.json(ok(shift))
})

/**
 * @openapi
 * /schedule/{id}/clock-out:
 *   post: { tags: [Schedule], summary: Clock out; returns the prefilled note payload }
 */
router.post('/:id/clock-out', (req, res) => {
  const shift = scheduleService.clockOut(id(req))
  logActivity('scheduled_shift', shift.id, req.session.userId, 'clocked_out')
  res.json(ok({ shift, prefill: scheduleService.notePrefill(shift.id) }))
})

router.get('/:id/note-prefill', (req, res) => {
  res.json(ok(scheduleService.notePrefill(id(req))))
})

/**
 * @openapi
 * /schedule/{id}/note:
 *   post: { tags: [Schedule], summary: Create the shift note for a (clocked-out) scheduled shift }
 */
router.post('/:id/note', validate(scheduleNoteSchema), (req, res) => {
  const result = scheduleService.createNoteFromShift(id(req), req.body, req.session.userId)
  logActivity('shift', result.note.id, req.session.userId, 'created', { from_schedule: id(req), incident: !!result.note.incident_flag })
  res.status(201).json(ok(result))
})

export default router
