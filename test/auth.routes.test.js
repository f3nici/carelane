import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

let app

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed() // creates the default admin / changeme user
  const { createApp } = await import('../server/app.js')
  app = createApp()
})

describe('auth routes', () => {
  it('rejects bad credentials with 401', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('logs in with the seeded admin and issues a CSRF token', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
    expect(res.status).toBe(200)
    expect(res.body.data.username).toBe('admin')
    expect(res.body.data.csrf_token).toBeTruthy()
    expect(res.headers['set-cookie']).toBeTruthy()
  })

  it('returns 401 from /me without a session', async () => {
    const res = await request(app).get('/api/v1/auth/me')
    expect(res.status).toBe(401)
  })

  it('enforces CSRF on state-changing requests', async () => {
    const agent = request.agent(app)
    await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
    // No x-csrf-token header → rejected.
    const res = await agent.post('/api/v1/clients').send({ first_name: 'A', last_name: 'B' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CSRF_ERROR')
  })

  it('rate-limits repeated failures with a 429', async () => {
    const attempt = () => request(app).post('/api/v1/auth/login').send({ username: 'ratelimited', password: 'nope' })
    let last
    for (let i = 0; i < 6; i++) last = await attempt()
    expect(last.status).toBe(429)
    expect(last.body.error.code).toBe('TOO_MANY_ATTEMPTS')
  })
})

describe('change password', () => {
  /** Log in a fresh agent and return it with its CSRF token. */
  async function loginAgent (password = 'changeme') {
    const agent = request.agent(app)
    const res = await agent.post('/api/v1/auth/login').send({ username: 'admin', password })
    return { agent, csrf: res.body.data.csrf_token }
  }

  it('rejects an unauthenticated change', async () => {
    // No session → no CSRF token, so the CSRF guard blocks it (403) before auth.
    const res = await request(app).post('/api/v1/auth/change-password')
      .send({ current_password: 'changeme', new_password: 'longenough123' })
    expect([401, 403]).toContain(res.status)
  })

  it('rejects a wrong current password', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.post('/api/v1/auth/change-password').set('x-csrf-token', csrf)
      .send({ current_password: 'nope', new_password: 'longenough123' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('rejects a too-short new password', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.post('/api/v1/auth/change-password').set('x-csrf-token', csrf)
      .send({ current_password: 'changeme', new_password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('changes the password and lets the new one log in', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.post('/api/v1/auth/change-password').set('x-csrf-token', csrf)
      .send({ current_password: 'changeme', new_password: 'brand-new-pass-1' })
    expect(res.status).toBe(200)
    expect(res.body.data.changed).toBe(true)

    const relog = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'brand-new-pass-1' })
    expect(relog.status).toBe(200)
    // Restore for any later tests sharing the seeded user.
    const { agent: a2, csrf: c2 } = await loginAgent('brand-new-pass-1')
    await a2.post('/api/v1/auth/change-password').set('x-csrf-token', c2)
      .send({ current_password: 'brand-new-pass-1', new_password: 'changeme' })
  })
})
