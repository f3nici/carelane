import crypto from 'node:crypto'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { getSetting } from './settingsService.js'
import { listScheduled } from './scheduleService.js'

/**
 * Read-only iCalendar (.ics) subscription feed. Any calendar app (Google
 * Calendar, Apple Calendar, Outlook, …) can subscribe to a user's roster via a
 * long-lived URL that carries a secret, unguessable token — the URL *is* the
 * credential (there is no cookie/OAuth on a calendar subscription), so it is
 * never shown to another user and can be rotated to revoke old subscriptions.
 *
 * This complements the optional one-way Google Calendar push: rather than the
 * operator connecting their Google account, they (or a support worker) paste a
 * URL into any calendar client. The feed is scoped exactly like the roster list
 * — an admin sees every scheduled shift, a worker only their own.
 *
 * Privacy: events carry only a short participant label (preferred name /
 * display name) plus location and times — never plan or health notes, mirroring
 * how the Google push and AI calls minimise what leaves the record.
 */

// How far back / forward the feed reaches. Bounded so a subscription stays small
// and a client never re-downloads years of history.
const PAST_DAYS = 60
const FUTURE_DAYS = 400
// Statuses worth surfacing on a calendar. Cancelled shifts are dropped (they did
// not happen); the rest map to iCal STATUS values.
const ICAL_STATUS = { scheduled: 'CONFIRMED', in_progress: 'CONFIRMED', completed: 'CONFIRMED' }

/** The stored feed token for a user, or null when they have not enabled one. */
export function feedToken (userId) {
  const row = sqlite.prepare('SELECT calendar_feed_token FROM users WHERE id = ?').get(userId)
  return row ? row.calendar_feed_token : null
}

/**
 * Resolve the (active) user who owns a feed token. Returns the minimal row the
 * feed needs — id, role, active — or null when the token is unknown/revoked or
 * the account is deactivated. The token is a 192-bit random secret, so a direct
 * indexed lookup is sufficient (no per-byte timing concern).
 * @param {string} token
 */
export function resolveUserByToken (token) {
  if (!token || typeof token !== 'string') return null
  const row = sqlite.prepare('SELECT id, role, active FROM users WHERE calendar_feed_token = ?').get(token)
  if (!row || !row.active) return null
  return row
}

/**
 * The public base URL of this install for building the subscribe link. Prefers
 * the configured `APP_BASE_URL`; otherwise derives it from the incoming request
 * so a same-origin deployment needs no extra config.
 * @param {import('express').Request} req
 */
function baseUrl (req) {
  if (config.appBaseUrl) return config.appBaseUrl
  return `${req.protocol}://${req.get('host')}`
}

/** The absolute subscribe URL for a token. */
function feedUrl (token, req) {
  return `${baseUrl(req)}/calendar/${token}.ics`
}

/**
 * Feed status for the current user: whether a token exists and, if so, the
 * subscribe URL. The token itself is only ever surfaced as part of the URL to
 * its own owner.
 * @param {{id:number}} user
 * @param {import('express').Request} req
 */
export function getFeedStatus (user, req) {
  const token = feedToken(user.id)
  return { enabled: !!token, url: token ? feedUrl(token, req) : null }
}

/**
 * Create (or replace) the user's feed token, returning the fresh status.
 * Rotating invalidates any existing subscription URL — the way to revoke a
 * leaked link.
 * @param {{id:number}} user
 * @param {import('express').Request} req
 */
export function rotateToken (user, req) {
  const token = crypto.randomBytes(24).toString('base64url')
  sqlite.prepare('UPDATE users SET calendar_feed_token = ?, updated_at = ? WHERE id = ?')
    .run(token, new Date().toISOString(), user.id)
  return getFeedStatus(user, req)
}

/**
 * Disable the feed by clearing the token. Existing subscriptions stop working
 * (the URL 404s).
 * @param {{id:number}} user
 * @param {import('express').Request} req
 */
export function disableFeed (user, req) {
  sqlite.prepare('UPDATE users SET calendar_feed_token = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id)
  return getFeedStatus(user, req)
}

/* ---- iCalendar rendering (RFC 5545) ---- */

/** Escape a text value: backslash, semicolon, comma and newlines per RFC 5545. */
function escapeText (value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Fold a content line to =75 octets, continuation lines prefixed with a space,
 * as required by RFC 5545. Works on octets (UTF-8 bytes), not characters.
 */
function foldLine (line) {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const chunks = []
  let start = 0
  // First line 75 octets, continuations 74 (the leading space counts).
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Do not split a multi-byte UTF-8 sequence: back up to a lead byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74
  }
  return chunks.join('\r\n ')
}

/** `YYYYMMDD` for an all-day DATE value. */
function toIcalDate (dateStr) {
  return String(dateStr).replace(/-/g, '')
}

/** `YYYYMMDDTHHMMSS` local-time value (paired with a TZID parameter). */
function toIcalLocalDateTime (dateStr, timeStr) {
  return `${toIcalDate(dateStr)}T${String(timeStr).replace(/:/g, '')}00`
}

/** `YYYYMMDDTHHMMSSZ` UTC stamp for DTSTAMP. */
function toIcalUtcStamp (date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Short, privacy-preserving label for a shift's participant. */
function shiftLabel (row) {
  return row.client_preferred_name || row.client_display_name || `Client #${row.client_id}`
}

/**
 * Build the VEVENT lines for one scheduled shift. Timed shifts become a
 * timezone-anchored event; a date-only shift becomes an all-day event.
 * @param {object} shift roster row from listScheduled
 * @param {string} tz operator timezone (TZID)
 * @param {string} host request host, used to make UIDs globally unique
 * @param {Date} stamp DTSTAMP for this generation
 */
function eventLines (shift, tz, host, stamp) {
  const lines = ['BEGIN:VEVENT']
  lines.push(`UID:carelane-shift-${shift.id}@${host}`)
  lines.push(`DTSTAMP:${toIcalUtcStamp(stamp)}`)
  if (shift.start_time && shift.end_time) {
    lines.push(`DTSTART;TZID=${tz}:${toIcalLocalDateTime(shift.scheduled_date, shift.start_time)}`)
    lines.push(`DTEND;TZID=${tz}:${toIcalLocalDateTime(shift.scheduled_date, shift.end_time)}`)
  } else {
    const next = new Date(`${shift.scheduled_date}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    lines.push(`DTSTART;VALUE=DATE:${toIcalDate(shift.scheduled_date)}`)
    lines.push(`DTEND;VALUE=DATE:${toIcalDate(next.toISOString().slice(0, 10))}`)
  }
  const summary = shift.title ? `${shiftLabel(shift)} · ${shift.title}` : `CareLane: ${shiftLabel(shift)}`
  lines.push(`SUMMARY:${escapeText(summary)}`)
  if (shift.location) lines.push(`LOCATION:${escapeText(shift.location)}`)
  lines.push(`DESCRIPTION:${escapeText('Scheduled support shift (managed by CareLane).')}`)
  lines.push(`STATUS:${ICAL_STATUS[shift.status] || 'CONFIRMED'}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * Render the full VCALENDAR document for a user's roster. Scoped to the user
 * (admins see all shifts; a worker sees only their own) over a bounded date
 * window. Cancelled and soft-deleted shifts are excluded.
 * @param {{id:number, role:string}} user
 * @param {string} host request host for UID/PRODID uniqueness
 * @returns {string} the .ics body (CRLF line endings)
 */
export function buildFeed (user, host) {
  const tz = getSetting('google_calendar_timezone', 'Australia/Perth')
  const today = new Date()
  const from = new Date(today.getTime() - PAST_DAYS * 86400000).toISOString().slice(0, 10)
  const to = new Date(today.getTime() + FUTURE_DAYS * 86400000).toISOString().slice(0, 10)
  const filters = { from, to }
  // A worker's feed is scoped to their own shifts; an admin's is unrestricted.
  if (user.role !== 'admin') filters.worker_id = user.id
  const shifts = listScheduled(filters).filter(s => s.status !== 'cancelled')

  const stamp = new Date()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CareLane//Roster//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:CareLane Roster',
    `X-WR-TIMEZONE:${tz}`
  ]
  for (const shift of shifts) lines.push(...eventLines(shift, tz, host, stamp))
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
