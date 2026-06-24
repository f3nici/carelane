import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers/db.js'

let ntfy, settingsService, sqlite, clientId, workerId
let fetchMock

const now = () => new Date().toISOString()
const isoDate = ms => new Date(ms).toISOString().slice(0, 10)

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  settingsService = await import('../server/services/settingsService.js')
  ntfy = await import('../server/services/ntfyService.js')

  workerId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w', 'x', 'admin')").run().lastInsertRowid
  clientId = sqlite.prepare("INSERT INTO clients (first_name, last_name, active, created_at) VALUES ('Ada', 'Lovelace', 1, ?)").run(now()).lastInsertRowid
})

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock
  // A configured, enabled, UTC-clocked baseline. Tests override as needed.
  settingsService.updateSettings({
    ntfy_enabled: 1,
    ntfy_topic: 'test-topic',
    ntfy_server_url: 'https://ntfy.example',
    ntfy_priority: 'default',
    ntfy_notify_plan_reviews: 1,
    ntfy_notify_incidents: 1,
    ntfy_notify_unbilled: 1,
    ntfy_notify_shift_reminders: 1,
    ntfy_shift_reminder_minutes: 60,
    google_calendar_timezone: 'UTC',
    ntfy_last_error: null,
    ntfy_last_digest_date: null
  })
})

describe('ntfyService.publish', () => {
  it('POSTs to <server>/<topic> with title and body, and records last_sent_at', async () => {
    const res = await ntfy.publish({ title: 'Hello', message: 'world', tags: ['memo'] })
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ntfy.example/test-topic')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBe('world')
    expect(opts.headers.Title).toBe('Hello')
    expect(opts.headers.Tags).toBe('memo')
    expect(settingsService.getSetting('ntfy_last_sent_at')).toBeTruthy()
  })

  it('is a no-op with an error when no topic is configured', async () => {
    settingsService.updateSettings({ ntfy_topic: '' })
    const res = await ntfy.publish({ message: 'x' })
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an aborted (timed-out) request to a clear timeout error', async () => {
    global.fetch = vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e })
    const res = await ntfy.publish({ message: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/timed out/i)
    expect(res.error).toMatch(/timeout in Settings/i)
    // The live error banner is recorded for the settings UI.
    expect(settingsService.getSetting('ntfy_last_error')).toBeTruthy()
  })

  it('surfaces a non-2xx response as an error', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }))
    const res = await ntfy.publish({ message: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('forbidden')
  })
})

describe('ntfyService.buildDigest', () => {
  beforeEach(() => {
    sqlite.exec('DELETE FROM service_agreements; DELETE FROM incident_reports; DELETE FROM shift_notes')
    // Plan review due in 10 days (inside the 30-day default window).
    sqlite.prepare("INSERT INTO service_agreements (client_id, title, status, end_date, created_at) VALUES (?, 'SA', 'active', ?, ?)")
      .run(clientId, isoDate(Date.now() + 10 * 86400000), now())
    // An open incident needing follow-up.
    sqlite.prepare("INSERT INTO incident_reports (client_id, worker_id, incident_date, status, created_at) VALUES (?, ?, ?, 'open', ?)")
      .run(clientId, workerId, isoDate(Date.now()), now())
    // A finalised, unbilled shift 20 days old (older than the 14-day default).
    sqlite.prepare('INSERT INTO shift_notes (client_id, worker_id, shift_date, finalised, billed, created_at) VALUES (?, ?, ?, 1, 0, ?)')
      .run(clientId, workerId, isoDate(Date.now() - 20 * 86400000), now())
  })

  it('produces one message per non-empty category', () => {
    const items = ntfy.buildDigest()
    expect(items.map(i => i.key).sort()).toEqual(['incidents', 'plan_reviews', 'unbilled'])
  })

  it('honours the per-category toggles', () => {
    settingsService.updateSettings({ ntfy_notify_plan_reviews: 0, ntfy_notify_unbilled: 0 })
    const items = ntfy.buildDigest()
    expect(items.map(i => i.key)).toEqual(['incidents'])
  })

  it('sendDigest pushes one notification per category', async () => {
    const res = await ntfy.sendDigest('manual', workerId)
    expect(res.sent).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('digestCounts mirrors the dashboard counts', () => {
    const c = ntfy.digestCounts()
    expect(c.plan_reviews).toBe(1)
    expect(c.incidents).toBe(1)
    expect(c.unbilled).toBe(1)
  })
})

describe('ntfyService shift reminders', () => {
  beforeEach(() => {
    sqlite.exec('DELETE FROM scheduled_shifts')
  })

  function schedule (startMs) {
    const d = new Date(startMs)
    return sqlite.prepare(`INSERT INTO scheduled_shifts
        (client_id, worker_id, title, scheduled_date, start_time, status, created_at)
        VALUES (?, ?, 'Park visit', ?, ?, 'scheduled', ?)`)
      .run(clientId, workerId, d.toISOString().slice(0, 10), d.toISOString().slice(11, 16), now()).lastInsertRowid
  }

  it('reminds a shift inside the lead window exactly once', async () => {
    const id = schedule(Date.now() + 30 * 60000) // 30 min out, lead is 60
    const sent = await ntfy.sendShiftReminders()
    expect(sent).toBe(1)
    expect(sqlite.prepare('SELECT reminder_sent_at FROM scheduled_shifts WHERE id = ?').get(id).reminder_sent_at).toBeTruthy()
    // A second sweep does not re-notify.
    fetchMock.mockClear()
    expect(await ntfy.sendShiftReminders()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores shifts beyond the lead window and ones already started', async () => {
    schedule(Date.now() + 5 * 3600000)  // 5 hours out
    schedule(Date.now() - 10 * 60000)   // already started
    expect(await ntfy.sendShiftReminders()).toBe(0)
  })

  it('does nothing when shift reminders are toggled off', async () => {
    settingsService.updateSettings({ ntfy_notify_shift_reminders: 0 })
    schedule(Date.now() + 30 * 60000)
    expect(await ntfy.sendShiftReminders()).toBe(0)
  })
})

describe('ntfyService timezone math', () => {
  it('converts a wall-clock time in a fixed-offset zone to the right UTC instant', () => {
    // Australia/Perth is UTC+8 year-round (no DST).
    const ms = ntfy._internal.zonedToUtcMs('2026-07-01', '09:00', 'Australia/Perth')
    expect(ms).toBe(Date.parse('2026-07-01T01:00:00Z'))
  })
})
