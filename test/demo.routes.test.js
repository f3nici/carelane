import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

// Public-demo mode is read from env at import time, so it must be set before any
// server module (config/connection/app) is imported. Each test file gets its own
// module registry, so this only affects this file.
let app

beforeAll(async () => {
  process.env.DEMO_MODE = 'true'
  process.env.DEMO_RESET_HOURS = '6'
  process.env.UPLOAD_PATH = path.join(os.tmpdir(), `carelane-demo-uploads-${process.pid}-${Date.now()}`)
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { resetDemoData } = await import('../server/services/demoService.js')
  resetDemoData()
  const { createApp } = await import('../server/app.js')
  app = createApp()
})

/** Log in and return an agent carrying the session cookie + its CSRF token. */
async function loginAgent (username, password = 'demo') {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data?.csrf_token, body: res.body.data }
}

describe('public demo mode', () => {
  it('advertises the demo on the unauthenticated /auth/config endpoint', async () => {
    const res = await request(app).get('/api/v1/auth/config')
    expect(res.status).toBe(200)
    expect(res.body.data.demo).toBe(true)
    expect(res.body.data.demo_username).toBe('demo')
    expect(res.body.data.demo_worker_username).toBe('demoworker')
  })

  it('logs in with the shared demo admin and flags the session as demo', async () => {
    const { body } = await loginAgent('demo')
    expect(body.username).toBe('demo')
    expect(body.role).toBe('admin')
    expect(body.demo).toBe(true)
  })

  it('logs in with the shared demo worker', async () => {
    const { body } = await loginAgent('demoworker')
    expect(body.username).toBe('demoworker')
    expect(body.role).toBe('worker')
  })

  it('seeds example participants visible to the admin', async () => {
    const { agent } = await loginAgent('demo')
    const res = await agent.get('/api/v1/clients')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(3)
  })

  it('scopes the demo worker to their assigned participants only', async () => {
    const { agent } = await loginAgent('demoworker')
    const res = await agent.get('/api/v1/clients')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
  })

  it('blocks changing the password (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/auth/change-password').set('x-csrf-token', csrf)
      .send({ current_password: 'demo', new_password: 'a-brand-new-password' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks enrolling 2FA (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks adding a passkey (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/auth/passkeys/register/options').set('x-csrf-token', csrf).send({ password: 'demo' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks creating a user (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/users').set('x-csrf-token', csrf)
      .send({ username: 'intruder', display_name: 'Intruder', password: 'longenough123', role: 'admin' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks deactivating a login (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const worker = (await agent.get('/api/v1/users')).body.data.find(u => u.username === 'demoworker')
    const res = await agent.put(`/api/v1/users/${worker.id}`).set('x-csrf-token', csrf).send({ active: 0 })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks saving ntfy settings (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.put('/api/v1/notifications/settings').set('x-csrf-token', csrf)
      .send({ topic: 'attacker-topic', enabled: 1 })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks sending a test push and the digest (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const test = await agent.post('/api/v1/notifications/test').set('x-csrf-token', csrf).send({})
    expect(test.status).toBe(403)
    expect(test.body.error.code).toBe('DEMO_LOCKED')
    const digest = await agent.post('/api/v1/notifications/send-now').set('x-csrf-token', csrf).send({})
    expect(digest.status).toBe(403)
    expect(digest.body.error.code).toBe('DEMO_LOCKED')
  })

  it('still allows reading ntfy status in the demo', async () => {
    const { agent } = await loginAgent('demo')
    const res = await agent.get('/api/v1/notifications/status')
    expect(res.status).toBe(200)
  })
})
