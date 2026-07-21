import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

// Coverage for the read-only iCal subscription feed: an admin (and a worker)
// generate a per-user token, the public `/calendar/<token>.ics` endpoint serves
// a valid VCALENDAR scoped to that user, and rotating / disabling the token
// revokes old subscription URLs.

let app
let admin, worker
let adminClient, workerClient

/** Log in through a fresh agent and return { agent, csrf }. */
async function loginAgent (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data.csrf_token }
}

/** Pull the token out of a subscribe URL like http://…/calendar/<token>.ics */
const tokenOf = url => url.match(/\/calendar\/([^/]+)\.ics$/)[1]

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()

  admin = await loginAgent('admin', 'changeme')

  adminClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Ada', last_name: 'Admin', preferred_name: 'Ada', ndis_number: '431000001' })).body.data
  workerClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Wanda', last_name: 'Worker', preferred_name: 'Wanda', ndis_number: '431000002' })).body.data

  // A worker login assigned to workerClient.
  const created = (await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
    .send({ username: 'cfworker', display_name: 'CF Worker', password: 'worker-pass-123', role: 'worker' })).body.data
  await admin.agent.put(`/api/v1/users/${created.id}/clients`).set('x-csrf-token', admin.csrf)
    .send({ client_ids: [workerClient.id] })

  // One shift rostered to the admin (default) and one to the worker.
  await admin.agent.post('/api/v1/schedule').set('x-csrf-token', admin.csrf)
    .send({ client_id: adminClient.id, scheduled_date: '2026-09-01', start_time: '09:00', end_time: '11:00', location: 'Community Centre' })
  await admin.agent.post('/api/v1/schedule').set('x-csrf-token', admin.csrf)
    .send({ client_id: workerClient.id, worker_id: created.id, scheduled_date: '2026-09-02', start_time: '13:00', end_time: '15:00' })

  worker = await loginAgent('cfworker', 'worker-pass-123')
})

describe('iCal calendar feed', () => {
  it('reports the feed disabled until a token is generated', async () => {
    const res = await admin.agent.get('/api/v1/schedule/calendar-feed')
    expect(res.status).toBe(200)
    expect(res.body.data.enabled).toBe(false)
    expect(res.body.data.url).toBe(null)
  })

  it('generates a subscribe URL and serves a valid VCALENDAR without auth', async () => {
    const gen = await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)
    expect(gen.status).toBe(200)
    expect(gen.body.data.enabled).toBe(true)
    const url = gen.body.data.url
    expect(url).toMatch(/\/calendar\/[\w-]+\.ics$/)

    // The public feed needs no cookie/CSRF — hit it with a bare client.
    const feed = await request(app).get(`/calendar/${tokenOf(url)}.ics`)
    expect(feed.status).toBe(200)
    expect(feed.headers['content-type']).toMatch(/text\/calendar/)
    expect(feed.text).toContain('BEGIN:VCALENDAR')
    expect(feed.text).toContain('END:VCALENDAR')
    // Admin sees every shift — both participants' labels appear.
    expect(feed.text).toContain('Ada')
    expect(feed.text).toContain('Wanda')
    expect(feed.text).toContain('DTSTART;TZID=')
    expect(feed.text).toContain('LOCATION:Community Centre')
    // CRLF line endings per RFC 5545.
    expect(feed.text).toContain('\r\n')
  })

  it('scopes a worker feed to their own roster only', async () => {
    const gen = await worker.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', worker.csrf)
    const feed = await request(app).get(`/calendar/${tokenOf(gen.body.data.url)}.ics`)
    expect(feed.status).toBe(200)
    expect(feed.text).toContain('Wanda')
    expect(feed.text).not.toContain('Ada')
  })

  it('renders all-day events and folds long lines (RFC 5545)', async () => {
    // A very long preferred name forces a SUMMARY line past 75 octets.
    const longName = 'A-really-quite-long-preferred-name-that-must-be-folded-across-multiple-lines-per-spec'
    const c = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
      .send({ first_name: 'Long', last_name: 'Name', preferred_name: longName, ndis_number: '431000003' })).body.data
    // No start/end time → an all-day event.
    await admin.agent.post('/api/v1/schedule').set('x-csrf-token', admin.csrf)
      .send({ client_id: c.id, scheduled_date: '2026-09-10' })

    const gen = await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)
    const feed = await request(app).get(`/calendar/${tokenOf(gen.body.data.url)}.ics`)
    expect(feed.status).toBe(200)
    expect(feed.text).toContain('DTSTART;VALUE=DATE:20260910')
    expect(feed.text).toContain('DTEND;VALUE=DATE:20260911')
    // A folded continuation line begins with CRLF + a single space.
    expect(feed.text).toMatch(/\r\n /)
  })

  it('includes participant birthdays as yearly, all-day events (age hidden)', async () => {
    await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
      .send({ first_name: 'Cake', last_name: 'Day', preferred_name: 'Cake', ndis_number: '431000004', date_of_birth: '1990-03-14' })
    const gen = await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)
    const feed = await request(app).get(`/calendar/${tokenOf(gen.body.data.url)}.ics`)
    expect(feed.status).toBe(200)
    expect(feed.text).toContain('UID:carelane-birthday-')
    expect(feed.text).toContain('RRULE:FREQ=YEARLY')
    // Anchored to a neutral base year (2000), not the birth year (1990).
    expect(feed.text).toContain('DTSTART;VALUE=DATE:20000314')
    expect(feed.text).not.toContain('1990')
    expect(feed.text).toMatch(/SUMMARY:.*Cake.*birthday/)
  })

  it('404s an unknown token', async () => {
    const res = await request(app).get('/calendar/not-a-real-token.ics')
    expect(res.status).toBe(404)
  })

  it('rotating the token revokes the previous subscribe URL', async () => {
    const first = (await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)).body.data.url
    const second = (await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)).body.data.url
    expect(first).not.toBe(second)
    expect((await request(app).get(`/calendar/${tokenOf(first)}.ics`)).status).toBe(404)
    expect((await request(app).get(`/calendar/${tokenOf(second)}.ics`)).status).toBe(200)
  })

  it('disabling the feed 404s the URL', async () => {
    const url = (await admin.agent.post('/api/v1/schedule/calendar-feed/rotate').set('x-csrf-token', admin.csrf)).body.data.url
    const off = await admin.agent.delete('/api/v1/schedule/calendar-feed').set('x-csrf-token', admin.csrf)
    expect(off.body.data.enabled).toBe(false)
    expect((await request(app).get(`/calendar/${tokenOf(url)}.ics`)).status).toBe(404)
  })

  it('requires authentication to manage the feed', async () => {
    expect((await request(app).get('/api/v1/schedule/calendar-feed')).status).toBe(401)
  })
})
