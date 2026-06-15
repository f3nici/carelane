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
      .send({ client_id: clientId, frequency: 'weekly', interval: 1, weekdays: [1, 4], start_date: '2026-08-03' })
    expect(res.status).toBe(201)
    const list = await agent.get('/api/v1/schedule').query({ from: '2026-08-01', to: '2026-08-31' })
    expect(list.body.data.filter(s => s.recurrence_id === res.body.data.id).length).toBeGreaterThan(0)
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
      .send({ client_id: clientId, frequency: 'hourly', start_date: '2026-08-03' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
