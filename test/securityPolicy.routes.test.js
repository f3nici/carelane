import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { freshDb } from './helpers/db.js'

let app, sqlite

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()
  // A second account with no second factor, for the enforcement check.
  const ts = new Date().toISOString()
  sqlite.prepare(`INSERT INTO users (username, password_hash, display_name, role, created_at, updated_at)
    VALUES ('worker', ?, 'Worker', 'worker', ?, ?)`).run(bcrypt.hashSync('workerpass1', 12), ts, ts)
})

/** Log in an agent, returning it with its CSRF token and the login body. */
async function login (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data.csrf_token, body: res.body.data }
}

describe('second-factor enforcement policy', () => {
  it('starts disabled and reports must_enrol_2fa=false', async () => {
    const { agent, body } = await login('admin', 'changeme')
    expect(body.must_enrol_2fa).toBe(false)
    const res = await agent.get('/api/v1/auth/security-policy')
    expect(res.status).toBe(200)
    expect(res.body.data.require_2fa).toBe(false)
  })

  it('refuses to require 2FA while the admin has no second factor of their own', async () => {
    const { agent, csrf } = await login('admin', 'changeme')
    const res = await agent.put('/api/v1/auth/security-policy').set('x-csrf-token', csrf).send({ require_2fa: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('POLICY_BLOCKED')
  })

  it('enables the policy once the admin has a second factor, then flags accounts that lack one', async () => {
    // Give the admin a passkey — a second factor that (unlike TOTP) does not put
    // the password login behind a code prompt, so the agent still gets a session.
    const ts = new Date().toISOString()
    const adminId = sqlite.prepare("SELECT id FROM users WHERE username = 'admin'").get().id
    sqlite.prepare(`INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, name, created_at, last_used_at)
      VALUES (?, 'dummy-cred-admin', ?, 0, 'Test key', ?, ?)`).run(adminId, Buffer.from([0]), ts, ts)
    const { agent, csrf } = await login('admin', 'changeme')
    const put = await agent.put('/api/v1/auth/security-policy').set('x-csrf-token', csrf).send({ require_2fa: 1 })
    expect(put.status).toBe(200)
    expect(put.body.data.require_2fa).toBe(true)

    // The admin satisfies the policy; the worker (no 2FA) is flagged to enrol.
    const worker = await login('worker', 'workerpass1')
    expect(worker.body.must_enrol_2fa).toBe(true)
    const me = await worker.agent.get('/api/v1/auth/me')
    expect(me.body.data.must_enrol_2fa).toBe(true)
  })

  it('is admin-only', async () => {
    const { agent } = await login('worker', 'workerpass1')
    const res = await agent.get('/api/v1/auth/security-policy')
    expect(res.status).toBe(403)
  })
})

describe('active sessions / devices', () => {
  it('lists the current session and flags it', async () => {
    const { agent } = await login('admin', 'changeme')
    const res = await agent.get('/api/v1/auth/sessions')
    expect(res.status).toBe(200)
    const sessions = res.body.data.sessions
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions.some(s => s.current)).toBe(true)
  })

  it('revokes other sessions but keeps the current one', async () => {
    const first = await login('admin', 'changeme')
    await login('admin', 'changeme') // a second device/session for the same user
    const res = await first.agent.post('/api/v1/auth/sessions/revoke-others').set('x-csrf-token', first.csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.revoked).toBeGreaterThanOrEqual(1)
    // The current session still works afterwards.
    const me = await first.agent.get('/api/v1/auth/me')
    expect(me.status).toBe(200)
  })

  it('cannot revoke a session id that belongs to a different user', async () => {
    const workerLogin = await login('worker', 'workerpass1')
    const adminLogin = await login('admin', 'changeme')
    const adminSessions = await adminLogin.agent.get('/api/v1/auth/sessions')
    const adminSid = adminSessions.body.data.sessions[0].sid
    const res = await workerLogin.agent.delete(`/api/v1/auth/sessions/${adminSid}`).set('x-csrf-token', workerLogin.csrf)
    expect(res.status).toBe(404)
  })
})
