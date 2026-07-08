import cron from 'node-cron'
import { isPublicHttpUrl } from '@carelane/core'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { getSetting, updateSettings } from './settingsService.js'
import { logActivity } from './activityService.js'
import { clientDisplayName } from './clientService.js'
import { agreementDueDate } from './agreementService.js'
import { countOpenIncidents } from './incidentService.js'

/**
 * ntfy push notifications. Turns the dashboard's "needs attention" counts into
 * proactive nudges to the operator's phone via an ntfy topic, plus per-shift
 * reminders a configurable lead time before a scheduled shift starts.
 *
 * Like the other optional integrations (Google Calendar, Square) this is a
 * best-effort, no-op-until-configured side channel: regular CRUD never depends
 * on it and never blocks on the network. The server URL, topic, request timeout
 * and all timings live in operator-editable settings (`ntfy_*`); only the
 * optional access token comes from env (see config). The timeout is generous by
 * default because a distant/self-hosted ntfy server can be slow to respond.
 *
 * Privacy: notifications carry only a short participant label (preferred name /
 * initials) and counts — never plan or health notes — mirroring how PII is
 * minimised for the calendar mirror and AI calls.
 */

/**
 * Default values for the operator-editable ntfy settings. Mirrored into the
 * settings table by the seed; also used as the in-code fallback so the service
 * behaves sensibly before a seed has run (and in tests).
 */
export const NTFY_DEFAULTS = {
  ntfy_enabled: 0,
  ntfy_server_url: 'https://ntfy.sh',
  ntfy_topic: '',
  ntfy_priority: 'default',
  ntfy_notify_plan_reviews: 1,
  ntfy_notify_incidents: 1,
  ntfy_notify_unbilled: 1,
  ntfy_notify_shift_reminders: 1,
  // Time of day (operator timezone) to push the daily "attention needed" digest.
  ntfy_digest_time: '08:00',
  // Plan reviews due: lead window (days) before a service agreement's end date.
  ntfy_plan_review_days: 30,
  // Unbilled shifts aging: only nudge once a finalised-but-unbilled shift is at
  // least this many days old.
  ntfy_unbilled_days: 14,
  // Shift reminders: how long before a scheduled shift starts to push a reminder.
  ntfy_shift_reminder_minutes: 60,
  // How long to wait for the ntfy server to respond (ms). Deliberately generous:
  // a distant/self-hosted server can take well over a second, and a too-tight
  // timeout silently drops notifications. Raise it for a slow/remote server.
  ntfy_timeout_ms: 10000
}

/** Read an ntfy setting, falling back to the documented default. */
const setting = key => getSetting(key, NTFY_DEFAULTS[key])
const bool = v => v === 1 || v === true || v === '1'
const num = (key) => Number(setting(key)) || Number(NTFY_DEFAULTS[key]) || 0

/** Effective request timeout (ms), clamped to a sane floor. */
const timeoutMs = () => Math.max(1000, num('ntfy_timeout_ms'))

/** Operator timezone, shared with the calendar mirror / roster clock. */
const tz = () => getSetting('google_calendar_timezone', 'Australia/Perth')

const isoDate = ms => new Date(ms).toISOString().slice(0, 10)

/** True once the operator has set a topic and enabled notifications. */
export function isConfigured () {
  return !!String(setting('ntfy_topic') || '').trim()
}

/** True when notifications are configured and switched on. */
export function isEnabled () {
  return bool(setting('ntfy_enabled')) && isConfigured()
}

/* ----------------------------- timezone helpers ---------------------------- */

/** Wall-clock parts ({year,month,day,hour,minute}) of an instant in a timezone. */
function localParts (date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date)
  const o = {}
  for (const p of parts) o[p.type] = p.value
  return o
}

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
function localDate (date, timeZone) {
  const o = localParts(date, timeZone)
  return `${o.year}-${o.month}-${o.day}`
}

/** Local wall-clock time (HH:MM) of an instant in a timezone. */
function localTime (date, timeZone) {
  const o = localParts(date, timeZone)
  // hour12:false can render midnight as '24' on some platforms — normalise.
  const hh = o.hour === '24' ? '00' : o.hour
  return `${hh}:${o.minute}`
}

/** Minutes a timezone is ahead of UTC at a given instant (handles DST). */
function tzOffsetMinutes (date, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT+0'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0))
}

/** UTC instant (ms) for a wall-clock date+time in a timezone. */
function zonedToUtcMs (dateStr, timeStr, timeZone) {
  const guess = Date.parse(`${dateStr}T${timeStr}:00Z`)
  if (Number.isNaN(guess)) return NaN
  return guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000
}

/* ------------------------------ live status -------------------------------- */

/** Record the live error banner (the audit log keeps the permanent record). */
function recordError (message) {
  updateSettings({ ntfy_last_error: { at: new Date().toISOString(), error: String(message || 'unknown').slice(0, 200) } })
}

/** Clear the live error banner. Returns the refreshed status. */
export function clearError () {
  updateSettings({ ntfy_last_error: null })
  return status()
}

/**
 * A preview of what the next digest would contain right now — the same
 * dashboard counts, surfaced so the settings UI can show "3 plan reviews due,
 * 1 incident…" before anything is pushed.
 * @returns {{plan_reviews:number, incidents:number, incidents_overdue:number, unbilled:number}}
 */
export function digestCounts () {
  return {
    plan_reviews: planReviewsDue().length,
    incidents: countOpenIncidents(),
    incidents_overdue: overdueIncidentCount(),
    unbilled: unbilledAging().count
  }
}

/** Operator-facing status for the settings UI. */
export function status () {
  return {
    enabled: bool(setting('ntfy_enabled')),
    configured: isConfigured(),
    server_url: setting('ntfy_server_url'),
    topic: setting('ntfy_topic'),
    priority: setting('ntfy_priority'),
    notify_plan_reviews: bool(setting('ntfy_notify_plan_reviews')),
    notify_incidents: bool(setting('ntfy_notify_incidents')),
    notify_unbilled: bool(setting('ntfy_notify_unbilled')),
    notify_shift_reminders: bool(setting('ntfy_notify_shift_reminders')),
    digest_time: setting('ntfy_digest_time'),
    plan_review_days: num('ntfy_plan_review_days'),
    unbilled_days: num('ntfy_unbilled_days'),
    shift_reminder_minutes: num('ntfy_shift_reminder_minutes'),
    timeout_ms: timeoutMs(),
    timezone: tz(),
    token_configured: !!config.ntfyToken,
    last_sent_at: getSetting('ntfy_last_sent_at', null),
    last_error: getSetting('ntfy_last_error', null),
    pending: digestCounts()
  }
}

/* ------------------------------- publishing -------------------------------- */

/** Strip non-latin1 chars so a value is safe to send as an HTTP header. */
const headerSafe = s => String(s).replace(/[^\x20-\x7E]/g, '').trim()

/** Deep link back into the app for a path, when the public base URL is known. */
const linkTo = path => (config.appBaseUrl ? `${config.appBaseUrl}${path}` : undefined)

/**
 * Publish a single message to the configured ntfy topic. Best-effort and never
 * throws. The request uses a generous, operator-configurable timeout (the
 * `ntfy_timeout_ms` setting, via AbortController) so a slow or distant ntfy
 * server does not silently drop the notification.
 * @param {{title?:string, message:string, tags?:string|string[], priority?:string, click?:string}} msg
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function publish ({ title, message, tags, priority, click } = {}) {
  const topic = String(setting('ntfy_topic') || '').trim()
  if (!topic) return { ok: false, error: 'No ntfy topic configured' }
  const base = String(setting('ntfy_server_url') || NTFY_DEFAULTS.ntfy_server_url).replace(/\/+$/, '')
  // Defence in depth: the settings write already rejects a non-public URL, but a
  // value persisted before that guard existed must not be used to reach the
  // host's own network / a metadata endpoint (SSRF).
  if (!isPublicHttpUrl(base)) {
    const msg = 'ntfy server URL is not a permitted public http(s) address'
    recordError(msg)
    return { ok: false, error: msg }
  }
  const url = `${base}/${encodeURIComponent(topic)}`

  const controller = new AbortController()
  const requestTimeout = timeoutMs()
  const timer = setTimeout(() => controller.abort(), requestTimeout)
  try {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' }
    if (title) headers.Title = headerSafe(title)
    const pr = priority || setting('ntfy_priority')
    if (pr && pr !== 'default') headers.Priority = String(pr)
    if (tags) headers.Tags = Array.isArray(tags) ? tags.join(',') : String(tags)
    if (click) headers.Click = click
    if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`

    const res = await fetch(url, { method: 'POST', headers, body: message ?? '', signal: controller.signal })
    if (!res.ok) {
      let detail = `ntfy server returned ${res.status}`
      try { const j = await res.json(); if (j && j.error) detail = String(j.error) } catch { /* not JSON */ }
      throw new Error(detail)
    }
    updateSettings({ ntfy_last_sent_at: new Date().toISOString(), ntfy_last_error: null })
    return { ok: true }
  } catch (err) {
    const errorMessage = err.name === 'AbortError'
      ? `ntfy request timed out after ${requestTimeout}ms — raise the request timeout in Settings if your server is slow/remote`
      : String(err.message || err).slice(0, 200)
    logActivity('ntfy', null, null, 'send_failed', { error: errorMessage.slice(0, 120) })
    recordError(errorMessage)
    return { ok: false, error: errorMessage }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send a test notification (from the settings "Send test" button).
 * @param {number} [userId]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendTest (userId = null) {
  const result = await publish({
    title: 'CareLane test',
    message: 'Push notifications are working. You will get nudges for plan reviews, incident follow-ups, unbilled shifts and upcoming shifts.',
    tags: ['white_check_mark'],
    click: linkTo('/')
  })
  logActivity('ntfy', null, userId, 'tested', { ok: result.ok })
  return result
}

/* ----------------------------- dashboard nudges ---------------------------- */

/** Active service agreements whose end date or review date falls within the lead window. */
function planReviewsDue () {
  const today = isoDate(Date.now())
  const soon = isoDate(Date.now() + num('ntfy_plan_review_days') * 86400000)
  const rows = sqlite.prepare(`SELECT a.title, a.end_date, a.review_date,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name,
      c.last_name AS client_last_name, c.id AS client_id
    FROM service_agreements a JOIN clients c ON c.id = a.client_id AND c.deleted_at IS NULL
    WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND a.status = 'active'
      AND ((a.end_date IS NOT NULL AND a.end_date BETWEEN @today AND @soon)
        OR (a.review_date IS NOT NULL AND a.review_date BETWEEN @today AND @soon))`).all({ today, soon })
  return rows
    .map(r => ({ ...r, ...agreementDueDate(r, today, soon) }))
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
}

/** Open/in-progress incident reports whose follow-up due date has passed. */
function overdueIncidentCount () {
  const today = isoDate(Date.now())
  return sqlite.prepare(`SELECT COUNT(*) AS c FROM incident_reports
    WHERE deleted_at IS NULL AND status IN ('open','in_progress')
      AND follow_up_due_date IS NOT NULL AND follow_up_due_date < ?`).get(today).c
}

/** Finalised-but-unbilled shifts that are at least the configured age old. */
function unbilledAging () {
  const cutoff = isoDate(Date.now() - num('ntfy_unbilled_days') * 86400000)
  const row = sqlite.prepare(`SELECT COUNT(*) AS c, MIN(shift_date) AS oldest FROM shift_notes
    WHERE deleted_at IS NULL AND archived_at IS NULL AND finalised = 1 AND billed = 0 AND shift_date <= ?`).get(cutoff)
  return { count: row.c, oldest: row.oldest }
}

/** Short, privacy-preserving label for a participant from a joined row. */
const label = row => clientDisplayName({
  id: row.client_id, preferred_name: row.client_preferred_name,
  first_name: row.client_first_name, last_name: row.client_last_name
})

/**
 * Build the per-category digest messages for whatever needs attention right now,
 * honouring the per-category toggles. Returns only categories with items.
 * @returns {Array<{key:string, title:string, message:string, tags:string[], click?:string}>}
 */
export function buildDigest () {
  const out = []

  if (bool(setting('ntfy_notify_plan_reviews'))) {
    const rows = planReviewsDue()
    if (rows.length) {
      const names = rows.slice(0, 5).map(r => `• ${label(r)} — review by ${r.due_date}`)
      if (rows.length > 5) names.push(`…and ${rows.length - 5} more`)
      out.push({
        key: 'plan_reviews',
        title: `${rows.length} plan review${rows.length === 1 ? '' : 's'} due`,
        message: names.join('\n'),
        tags: ['memo'],
        click: linkTo('/agreements')
      })
    }
  }

  if (bool(setting('ntfy_notify_incidents'))) {
    const open = countOpenIncidents()
    if (open) {
      const overdue = overdueIncidentCount()
      out.push({
        key: 'incidents',
        title: `${open} incident${open === 1 ? '' : 's'} need follow-up`,
        message: overdue
          ? `${open} open incident report${open === 1 ? '' : 's'}, ${overdue} past the follow-up due date.`
          : `${open} open incident report${open === 1 ? '' : 's'} awaiting follow-up.`,
        tags: ['warning'],
        click: linkTo('/incidents')
      })
    }
  }

  if (bool(setting('ntfy_notify_unbilled'))) {
    const { count, oldest } = unbilledAging()
    if (count) {
      out.push({
        key: 'unbilled',
        title: `${count} unbilled shift${count === 1 ? '' : 's'} aging`,
        message: `${count} finalised shift${count === 1 ? '' : 's'} not yet billed${oldest ? ` (oldest ${oldest})` : ''}.`,
        tags: ['heavy_dollar_sign'],
        click: linkTo('/shifts')
      })
    }
  }

  return out
}

/**
 * Send the "attention needed" digest now (manual trigger or scheduled). Pushes
 * one notification per non-empty, enabled category.
 * @param {string} [trigger] 'manual' | 'scheduled'
 * @param {number} [userId]
 * @returns {Promise<{ok:boolean, sent:number, categories:string[], skipped?:string, error?:string}>}
 */
export async function sendDigest (trigger = 'manual', userId = null) {
  if (!isConfigured()) return { ok: false, sent: 0, categories: [], error: 'ntfy is not configured' }
  const items = buildDigest()
  if (!items.length) {
    if (trigger === 'manual') logActivity('ntfy', null, userId, 'digest_sent', { trigger, sent: 0 })
    return { ok: true, sent: 0, categories: [], skipped: 'nothing needs attention' }
  }
  let sent = 0
  let lastError = null
  for (const item of items) {
    const r = await publish(item)
    if (r.ok) sent++
    else lastError = r.error
  }
  logActivity('ntfy', null, userId, 'digest_sent', { trigger, sent, categories: items.map(i => i.key).join(',') })
  return { ok: sent === items.length, sent, categories: items.map(i => i.key), error: lastError || undefined }
}

/* ------------------------------ shift reminders ---------------------------- */

/**
 * Scheduled shifts starting within the reminder lead time that have not been
 * reminded yet. Only timed shifts (with a start_time) qualify.
 * @returns {object[]} rows with participant name columns
 */
function dueShiftReminders () {
  const lead = num('ntfy_shift_reminder_minutes')
  const now = Date.now()
  const zone = tz()
  // Bound the scan to recent/near-future dates; the time-of-day filter is applied
  // in JS against the operator timezone.
  const fromDate = isoDate(now - 86400000)
  const rows = sqlite.prepare(`SELECT s.id, s.title, s.scheduled_date, s.start_time, s.location, s.client_id,
      c.preferred_name AS client_preferred_name, c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM scheduled_shifts s JOIN clients c ON c.id = s.client_id AND c.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND s.status = 'scheduled' AND s.reminder_sent_at IS NULL
      AND s.start_time IS NOT NULL AND s.scheduled_date >= ?`).all(fromDate)
  return rows.filter(s => {
    const startMs = zonedToUtcMs(s.scheduled_date, s.start_time, zone)
    if (Number.isNaN(startMs)) return false
    const minutesUntil = (startMs - now) / 60000
    return minutesUntil >= 0 && minutesUntil <= lead
  })
}

/**
 * Push reminders for any imminent scheduled shifts and stamp reminder_sent_at so
 * each is only sent once. On a send failure the stamp is left unset so the next
 * sweep retries (within the lead window).
 * @returns {Promise<number>} reminders sent
 */
export async function sendShiftReminders () {
  if (!isConfigured() || !bool(setting('ntfy_notify_shift_reminders'))) return 0
  const stamp = sqlite.prepare('UPDATE scheduled_shifts SET reminder_sent_at = ? WHERE id = ?')
  let sent = 0
  for (const s of dueShiftReminders()) {
    const r = await publish({
      title: `Shift soon: ${label(s)}`,
      message: `${s.title || 'Support shift'} starts at ${s.start_time}${s.location ? ` · ${s.location}` : ''}.`,
      tags: ['alarm_clock'],
      click: linkTo('/roster')
    })
    if (r.ok) {
      stamp.run(new Date().toISOString(), s.id)
      sent++
    }
  }
  return sent
}

/* -------------------------------- scheduler -------------------------------- */

/**
 * Send the daily digest if the operator's local clock has just reached the
 * configured digest time and it has not already gone out today. The per-day flag
 * is written before sending so a double-fire within the same minute can't
 * double-notify.
 */
async function maybeSendDigest () {
  const zone = tz()
  if (localTime(new Date(), zone) !== String(setting('ntfy_digest_time') || NTFY_DEFAULTS.ntfy_digest_time)) return
  const today = localDate(new Date(), zone)
  if (getSetting('ntfy_last_digest_date', null) === today) return
  updateSettings({ ntfy_last_digest_date: today })
  await sendDigest('scheduled')
}

/** One scheduler tick: shift reminders + (at the configured time) the digest. */
async function tick () {
  if (!isEnabled()) return
  try {
    await sendShiftReminders()
    await maybeSendDigest()
  } catch (err) {
    logActivity('ntfy', null, null, 'tick_failed', { error: String(err.message || err).slice(0, 120) })
  }
}

/**
 * Run the notification sweep every minute. The tick is a cheap no-op while
 * notifications are disabled or unconfigured. Safe to call once at boot.
 */
export function scheduleNotifications () {
  cron.schedule('* * * * *', () => { tick() })
}

// Exposed for tests.
export const _internal = { localTime, localDate, zonedToUtcMs, tzOffsetMinutes, dueShiftReminders, buildDigest, maybeSendDigest }
