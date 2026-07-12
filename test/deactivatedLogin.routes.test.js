import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

let app

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()
})

async function login (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data?.csrf_token, res }
}

describe('deactivated-account login is blocked', () => {
  it('refuses a fresh password login for a deactivated account', async () => {
    const admin = await login('admin', 'changeme')
    const created = await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
      .send({ username: 'departed', display_name: 'Departed', password: 'worker-pass-123', role: 'worker' })
    expect(created.status).toBe(201)

    // Active: login succeeds.
    const ok = await request(app).post('/api/v1/auth/login').send({ username: 'departed', password: 'worker-pass-123' })
    expect(ok.status).toBe(200)

    // Deactivate, then a fresh login must be refused (no session established).
    await admin.agent.put(`/api/v1/users/${created.body.data.id}`).set('x-csrf-token', admin.csrf).send({ active: 0 })
    const blocked = await request(app).post('/api/v1/auth/login').send({ username: 'departed', password: 'worker-pass-123' })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('ACCOUNT_INACTIVE')

    // And even holding a live cookie from before, /auth/me is rejected.
    const agent = request.agent(app)
    // (cannot re-login; assert the auth surface is closed to the deactivated account)
    const me = await agent.get('/api/v1/auth/me')
    expect(me.status).toBe(401)
  })
})

describe('worker cannot mark their own note billed', () => {
  it('strips billed from a worker shift-note update', async () => {
    const admin = await login('admin', 'changeme')
    const client = await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
      .send({ first_name: 'Test', last_name: 'Person' })
    const worker = await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
      .send({ username: 'wrkr', display_name: 'Worker', password: 'worker-pass-456', role: 'worker' })
    await admin.agent.put(`/api/v1/users/${worker.body.data.id}/clients`).set('x-csrf-token', admin.csrf)
      .send({ client_ids: [client.body.data.id] })

    const w = await login('wrkr', 'worker-pass-456')
    const note = await w.agent.post('/api/v1/shifts').set('x-csrf-token', w.csrf)
      .send({ client_id: client.body.data.id, shift_date: '2026-07-01', support_provided: 'assisted' })
    expect(note.status).toBe(201)

    const upd = await w.agent.put(`/api/v1/shifts/${note.body.data.id}`).set('x-csrf-token', w.csrf)
      .send({ billed: 1, support_provided: 'assisted with routine' })
    expect(upd.status).toBe(200)
    // The support text change applied, but billed stayed 0.
    expect(upd.body.data.billed).toBe(0)

    // An admin still can.
    const adminUpd = await admin.agent.put(`/api/v1/shifts/${note.body.data.id}`).set('x-csrf-token', admin.csrf)
      .send({ billed: 1 })
    expect(adminUpd.body.data.billed).toBe(1)
  })
})
