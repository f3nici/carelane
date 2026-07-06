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

  // ── Abuse hardening: uploads, heavy exports and backups are locked so a
  // public visitor cannot fill the host's disk or spam resource-heavy work.
  it('blocks running a manual backup (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/settings/backups/run').set('x-csrf-token', csrf).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('still allows listing backups in the demo (read-only)', async () => {
    const { agent } = await loginAgent('demo')
    const res = await agent.get('/api/v1/settings/backups')
    expect(res.status).toBe(200)
  })

  it('blocks uploading a logo (DEMO_LOCKED, before the file is written)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/settings/logo').set('x-csrf-token', csrf)
      .attach('logo', Buffer.from('\x89PNG\r\n\x1a\n'), 'logo.png')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks uploading a knowledge-base PDF (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const res = await agent.post('/api/v1/documents').set('x-csrf-token', csrf)
      .attach('file', Buffer.from('%PDF-1.4'), 'doc.pdf')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks uploading a participant document, and heavy exports (DEMO_LOCKED)', async () => {
    const { agent, csrf } = await loginAgent('demo')
    const clients = (await agent.get('/api/v1/clients')).body.data
    const clientId = clients[0].id

    const upload = await agent.post(`/api/v1/clients/${clientId}/documents`).set('x-csrf-token', csrf)
      .attach('file', Buffer.from('%PDF-1.4'), 'consent.pdf')
    expect(upload.status).toBe(403)
    expect(upload.body.error.code).toBe('DEMO_LOCKED')

    const jsonExport = await agent.get(`/api/v1/clients/${clientId}/export`)
    expect(jsonExport.status).toBe(403)
    expect(jsonExport.body.error.code).toBe('DEMO_LOCKED')

    const zipExport = await agent.get(`/api/v1/clients/${clientId}/export.zip`)
    expect(zipExport.status).toBe(403)
    expect(zipExport.body.error.code).toBe('DEMO_LOCKED')
  })

  it('blocks the generative PDF exports for incidents, reports and agreements (DEMO_LOCKED)', async () => {
    const { agent } = await loginAgent('demo')
    const incidentId = (await agent.get('/api/v1/incidents')).body.data[0].id
    const reportId = (await agent.get('/api/v1/reports')).body.data[0].id
    const agreementId = (await agent.get('/api/v1/agreements')).body.data[0].id

    for (const url of [
      `/api/v1/incidents/${incidentId}/export.pdf`,
      `/api/v1/reports/${reportId}/pdf`,
      `/api/v1/agreements/${agreementId}/pdf`
    ]) {
      const res = await agent.get(url)
      expect(res.status, url).toBe(403)
      expect(res.body.error.code, url).toBe('DEMO_LOCKED')
    }
  })

  it('still serves a seeded participant document download in the demo', async () => {
    const { agent } = await loginAgent('demo')
    const clients = (await agent.get('/api/v1/clients')).body.data
    let served = false
    for (const c of clients) {
      const docs = (await agent.get(`/api/v1/clients/${c.id}/documents`)).body.data
      if (!docs.length) continue
      const res = await agent.get(`/api/v1/clients/${c.id}/documents/${docs[0].id}/file`)
      expect(res.status).toBe(200)
      served = true
      break
    }
    expect(served).toBe(true)
  })
})
