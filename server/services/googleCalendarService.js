import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { encrypt, decrypt } from './cryptoService.js'
import { getSetting, updateSettings } from './settingsService.js'
import { getClient, clientDisplayName } from './clientService.js'
import { logActivity } from './activityService.js'

/**
 * Google Calendar one-way push. CareLane mirrors scheduled shifts into the
 * operator's Google Calendar as events. App credentials come from env
 * (config.google*), the OAuth refresh token is stored encrypted in settings
 * (`google_refresh_token_enc`, a protected key). All sync is best-effort and a
 * no-op until both are present — shift CRUD never depends on it.
 *
 * Privacy: events carry only a short label (preferred name / initials) and
 * location, never plan/health notes — mirroring how PII is minimised for AI.
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/calendar/v3'
const TOKEN_KEY = 'google_refresh_token_enc'

// Cached access token (memory only) to avoid refreshing on every event.
let accessToken = null
let accessTokenExpiry = 0

/** True when Google OAuth app credentials are configured in the environment. */
export function isConfigured () {
  return !!(config.googleClientId && config.googleClientSecret)
}

/** Read the encrypted refresh token straight from settings (protected key). */
function storedRefreshToken () {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY)
  return row && row.value ? decrypt(row.value) : null
}

/** True when an account has been connected (a refresh token is stored). */
export function isConnected () {
  return isConfigured() && !!storedRefreshToken()
}

/** True when sync is configured, connected and enabled by the operator. */
export function syncEnabled () {
  return isConnected() && !!getSetting('google_calendar_enabled', 0)
}

/** Number of scheduled shifts currently mirrored into Google (have an event id). */
function syncedShiftCount () {
  const row = sqlite.prepare(
    'SELECT COUNT(*) AS c FROM scheduled_shifts WHERE google_event_id IS NOT NULL AND deleted_at IS NULL'
  ).get()
  return row ? row.c : 0
}

/** Most recent sync failure recorded in the audit log, for surfacing in the UI. */
function lastSyncError () {
  const row = sqlite.prepare(
    "SELECT created_at, details FROM activity_log WHERE entity_type = 'google_calendar' AND action = 'sync_failed' ORDER BY id DESC LIMIT 1"
  ).get()
  if (!row) return null
  let error = null
  try { error = JSON.parse(row.details || '{}').error || null } catch { /* ignore */ }
  return { at: row.created_at, error }
}

/** Operator-facing connection status for the settings UI. */
export function status () {
  const connected = isConnected()
  return {
    configured: isConfigured(),
    connected,
    enabled: !!getSetting('google_calendar_enabled', 0),
    account_email: getSetting('google_account_email', null),
    calendar_id: getSetting('google_calendar_id', 'primary'),
    timezone: getSetting('google_calendar_timezone', 'Australia/Perth'),
    last_synced_at: getSetting('google_last_synced_at', null),
    synced_shifts: connected ? syncedShiftCount() : 0,
    last_sync_error: connected ? lastSyncError() : null
  }
}

/**
 * Live health check: confirm the stored credentials can actually reach the
 * configured calendar. Hits the Calendar API for the calendar's metadata
 * (read-only) so the operator can verify the integration works end-to-end.
 * Never throws — returns a result object for the settings UI.
 * @returns {Promise<{ok:boolean, calendar_summary?:string, calendar_timezone?:string, error?:string}>}
 */
export async function testConnection () {
  if (!isConnected()) return { ok: false, error: 'Google Calendar is not connected' }
  try {
    const token = await getAccessToken()
    const calendarId = encodeURIComponent(getSetting('google_calendar_id', 'primary'))
    const res = await fetch(`${API_BASE}/calendars/${calendarId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      const detail = res.status === 404 ? 'Calendar not found — check the Calendar ID' : `Google API returned ${res.status}`
      return { ok: false, error: detail }
    }
    const cal = await res.json()
    return { ok: true, calendar_summary: cal.summary || null, calendar_timezone: cal.timeZone || null }
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 120) }
  }
}

/**
 * Build the Google consent URL. `state` is an opaque value echoed back to the
 * callback (used as a lightweight CSRF guard).
 * @param {string} state
 * @returns {string}
 */
export function getAuthUrl (state) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)')
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  })
  return `${AUTH_BASE}?${params.toString()}`
}

/**
 * Exchange an authorization code for tokens and persist the refresh token
 * (encrypted). Also records the connected account email for the UI.
 * @param {string} code
 */
export async function handleCallback (code) {
  if (!isConfigured()) throw new Error('Google Calendar is not configured')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: 'authorization_code'
    })
  })
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`)
  const tok = await res.json()
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token — revoke prior access and reconnect')
  accessToken = tok.access_token
  accessTokenExpiry = Date.now() + (tok.expires_in || 3600) * 1000 - 60000
  // Protected key — write the ciphertext directly (updateSettings skips it).
  sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(TOKEN_KEY, encrypt(tok.refresh_token))
  const email = await fetchAccountEmail(tok.access_token)
  updateSettings({ google_calendar_enabled: 1, google_account_email: email })
}

/** Best-effort lookup of the connected account's email for display. */
async function fetchAccountEmail (token) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    return (await res.json()).email || null
  } catch { return null }
}

/** Forget the stored token and disable sync. Events already pushed remain. */
export function disconnect () {
  accessToken = null
  accessTokenExpiry = 0
  sqlite.prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
  updateSettings({ google_calendar_enabled: 0, google_account_email: null })
}

/** Get a valid access token, refreshing via the stored refresh token if needed. */
async function getAccessToken () {
  if (accessToken && Date.now() < accessTokenExpiry) return accessToken
  const refresh = storedRefreshToken()
  if (!refresh) throw new Error('Google Calendar is not connected')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token'
    })
  })
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`)
  const tok = await res.json()
  accessToken = tok.access_token
  accessTokenExpiry = Date.now() + (tok.expires_in || 3600) * 1000 - 60000
  return accessToken
}

/**
 * Build a Google Calendar event body from a scheduled shift. Times become a
 * timed event; a date-only shift becomes an all-day event.
 */
function toEventBody (shift, label) {
  const tz = getSetting('google_calendar_timezone', 'Australia/Perth')
  const event = {
    summary: shift.title || `CareLane: ${label}`,
    location: shift.location || undefined,
    description: 'Scheduled support shift (managed by CareLane).',
    source: { title: 'CareLane' }
  }
  if (shift.start_time && shift.end_time) {
    event.start = { dateTime: `${shift.scheduled_date}T${shift.start_time}:00`, timeZone: tz }
    event.end = { dateTime: `${shift.scheduled_date}T${shift.end_time}:00`, timeZone: tz }
  } else {
    const next = new Date(`${shift.scheduled_date}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    event.start = { date: shift.scheduled_date }
    event.end = { date: next.toISOString().slice(0, 10) }
  }
  return event
}

/** Short, privacy-preserving label for a client (preferred name or initials). */
function clientLabel (clientId) {
  try {
    const c = getClient(clientId)
    return c.preferred_name || clientDisplayName(c) || `Client #${clientId}`
  } catch { return `Client #${clientId}` }
}

/**
 * Create or update the Google event for a scheduled shift, storing the returned
 * event id back on the row. No-op (and swallows errors) when sync is disabled,
 * so it is safe to call fire-and-forget from shift CRUD.
 * @param {object} shift scheduled-shift row (must include id, client_id, ...)
 */
export async function syncScheduledShift (shift) {
  if (!syncEnabled()) return
  if (shift.status === 'cancelled' || shift.deleted_at) return removeScheduledShift(shift)
  try {
    const token = await getAccessToken()
    const calendarId = encodeURIComponent(getSetting('google_calendar_id', 'primary'))
    const body = toEventBody(shift, clientLabel(shift.client_id))
    const existing = shift.google_event_id
    const url = existing
      ? `${API_BASE}/calendars/${calendarId}/events/${encodeURIComponent(existing)}`
      : `${API_BASE}/calendars/${calendarId}/events`
    const res = await fetch(url, {
      method: existing ? 'PUT' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.status === 404 && existing) {
      // Event was removed in Google — recreate it.
      sqlite.prepare('UPDATE scheduled_shifts SET google_event_id = NULL WHERE id = ?').run(shift.id)
      return syncScheduledShift({ ...shift, google_event_id: null })
    }
    if (!res.ok) throw new Error(`Google event sync failed (${res.status})`)
    const event = await res.json()
    if (event.id && event.id !== existing) {
      sqlite.prepare('UPDATE scheduled_shifts SET google_event_id = ? WHERE id = ?').run(event.id, shift.id)
    }
    // Record a heartbeat so the settings UI can show sync is live.
    updateSettings({ google_last_synced_at: new Date().toISOString() })
  } catch (err) {
    logActivity('google_calendar', shift.id, null, 'sync_failed', { error: String(err.message || err).slice(0, 120) })
  }
}

/**
 * Delete the Google event for a scheduled shift (best-effort) and clear the id.
 * @param {object} shift
 */
export async function removeScheduledShift (shift) {
  if (!shift.google_event_id || !isConnected()) return
  try {
    const token = await getAccessToken()
    const calendarId = encodeURIComponent(getSetting('google_calendar_id', 'primary'))
    await fetch(`${API_BASE}/calendars/${calendarId}/events/${encodeURIComponent(shift.google_event_id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    sqlite.prepare('UPDATE scheduled_shifts SET google_event_id = NULL WHERE id = ?').run(shift.id)
  } catch (err) {
    logActivity('google_calendar', shift.id, null, 'sync_failed', { error: String(err.message || err).slice(0, 120) })
  }
}
