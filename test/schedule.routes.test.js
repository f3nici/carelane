import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

let app, agent, csrf, clientId

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()
  agent = request.agent(app)
  const login = await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
  csrf = login.body.data.csrf_token
  const client = await agent.post('/api/v1/clients').set('x-csrf-token', csrf)
    .send({ first_name: 'Roo', last_name: 'Kanga', ndis_number: '430000099' })
  clientId = client.body.data.id
})

/** ISO date `n` days from today — keeps the expectations from going stale. */
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

/** Create an open-ended daily series starting today, as the roster would. */
async function newSeries (over = {}) {
  const res = await agent.post('/api/v1/schedule/recurrences').set('x-csrf-token', csrf)
    .send({ client_id: clientId, frequency: 'daily', interval: 1, start_date: day(0), ...over })
  return res.body.data
}

/** The series' live (undeleted) occurrences, oldest first. */
async function occurrencesOf (recurrenceId) {
  const res = await agent.get('/api/v1/schedule').query({ from: day(0), to: day(90) })
  return res.body.data.filter(s => s.recurrence_id === recurrenceId)
}

describe('schedule routes', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/schedule')
    expect(res.status).toBe(401)
  })

  it('schedules, lists, clocks in/out and writes the linked note', async () => {
    const create = await agent.post('/api/v1/schedule').set('x-csrf-token', csrf)
      .send({ client_id: clientId, scheduled_date: '2026-08-10', start_time: '09:00', end_time: '11:00' })
    expect(create.status).toBe(201)
    const id = create.body.data.id

    const list = await agent.get('/api/v1/schedule').query({ from: '2026-08-01', to: '2026-08-31' })
    expect(list.status).toBe(200)
    expect(list.body.data.some(s => s.id === id)).toBe(true)

    const cin = await agent.post(`/api/v1/schedule/${id}/clock-in`).set('x-csrf-token', csrf)
    expect(cin.body.data.status).toBe('in_progress')

    const cout = await agent.post(`/api/v1/schedule/${id}/clock-out`).set('x-csrf-token', csrf)
    expect(cout.status).toBe(200)
    expect(cout.body.data.prefill.client_id).toBe(clientId)

    const note = await agent.post(`/api/v1/schedule/${id}/note`).set('x-csrf-token', csrf)
      .send({ body: 'Supported with shopping.' })
    expect(note.status).toBe(201)
    expect(note.body.data.note.body).toBe('Supported with shopping.')
    expect(note.body.data.scheduled.shift_note_id).toBe(note.body.data.note.id)
  })

  it('creates a recurring series that materialises occurrences', async () => {
    const res = await agent.post('/api/v1/schedule/recurrences').set('x-csrf-token', csrf)
      .send({ client_id: clientId, frequency: 'daily', interval: 1, start_date: day(0) })
    expect(res.status).toBe(201)
    const list = await agent.get('/api/v1/schedule').query({ from: day(0), to: day(30) })
    expect(list.body.data.filter(s => s.recurrence_id === res.body.data.id).length).toBeGreaterThan(0)
  })

  it('edits a whole series and rewrites every upcoming occurrence', async () => {
    const rec = await newSeries({ start_time: '09:00', location: 'Home' })
    const res = await agent.put(`/api/v1/schedule/recurrences/${rec.id}`).set('x-csrf-token', csrf)
      .send({ start_time: '14:00', location: 'Community centre' })
    expect(res.status).toBe(200)
    expect(res.body.data.occurrences_created).toBe(rec.upcoming_count)
    const shifts = await occurrencesOf(rec.id)
    expect(shifts.length).toBe(rec.upcoming_count)
    expect(shifts.every(s => s.start_time === '14:00' && s.location === 'Community centre')).toBe(true)
  })

  it('stops an open-ended series from a date and keeps the earlier shifts', async () => {
    const rec = await newSeries()
    const res = await agent.post(`/api/v1/schedule/recurrences/${rec.id}/end`).set('x-csrf-token', csrf)
      .send({ from: day(2) })
    expect(res.status).toBe(200)
    expect(res.body.data.until_date).toBe(day(1))
    const shifts = await occurrencesOf(rec.id)
    expect(shifts.map(s => s.scheduled_date)).toEqual([day(0), day(1)])
  })

  it('deletes a whole series and all of its upcoming shifts', async () => {
    const rec = await newSeries()
    const res = await agent.delete(`/api/v1/schedule/recurrences/${rec.id}`).set('x-csrf-token', csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.occurrences_removed).toBe(rec.upcoming_count)
    expect((await occurrencesOf(rec.id)).length).toBe(0)
    const gone = await agent.get(`/api/v1/schedule/recurrences/${rec.id}`)
    expect(gone.status).toBe(404)
  })

  it('lists series with the occurrence counts the roster shows', async () => {
    const rec = await newSeries({ title: 'Swimming' })
    const res = await agent.get('/api/v1/schedule/recurrences')
    const listed = res.body.data.find(r => r.id === rec.id)
    expect(listed.title).toBe('Swimming')
    expect(listed.client_display_name).toBe('Roo Kanga')
    expect(listed.upcoming_count).toBeGreaterThan(0)
    expect(listed.next_date).toBe(day(0))
  })

  it('reports Google Calendar as not configured by default', async () => {
    const res = await agent.get('/api/v1/schedule/google/status')
    expect(res.status).toBe(200)
    expect(res.body.data.configured).toBe(false)
    expect(res.body.data.connected).toBe(false)
    expect(res.body.data.synced_shifts).toBe(0)
    expect(res.body.data.last_sync_error).toBe(null)
  })

  it('reports a failed test when Google Calendar is not connected', async () => {
    const res = await agent.post('/api/v1/schedule/google/test').set('x-csrf-token', csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.ok).toBe(false)
    expect(res.body.data.error).toMatch(/not connected/i)
  })

  it('reports nothing synced when sync-all runs while disconnected', async () => {
    const res = await agent.post('/api/v1/schedule/google/sync-all').set('x-csrf-token', csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.ok).toBe(false)
    expect(res.body.data.synced).toBe(0)
  })

  it('clears the sync-error banner', async () => {
    const res = await agent.post('/api/v1/schedule/google/clear-error').set('x-csrf-token', csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.last_sync_error).toBe(null)
  })

  it('rejects an invalid recurrence frequency', async () => {
    const res = await agent.post('/api/v1/schedule/recurrences').set('x-csrf-token', csrf)
      .send({ client_id: clientId, frequency: 'hourly', start_date: day(0) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
