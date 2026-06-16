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

/** Log in a fresh agent and return it with its CSRF token. */
async function loginAgent () {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
  return { agent, csrf: res.body.data.csrf_token }
}

describe('passkey routes', () => {
  it('issues passwordless login options without a session or CSRF token', async () => {
    const res = await request(app).post('/api/v1/auth/passkeys/login/options').send({})
    expect(res.status).toBe(200)
    expect(res.body.data.challenge).toBeTruthy()
    // Discoverable-credential flow: no specific credentials are demanded.
    expect(res.body.data.allowCredentials ?? []).toEqual([])
  })

  it('requires a session to begin registration', async () => {
    // Registration is not in the CSRF-exempt passkey-login path, so an
    // unauthenticated (token-less) request is blocked by the CSRF guard.
    const res = await request(app).post('/api/v1/auth/passkeys/register/options').send({})
    expect([401, 403]).toContain(res.status)
  })

  it('returns registration options and an empty list for a fresh user', async () => {
    const { agent, csrf } = await loginAgent()
    const list = await agent.get('/api/v1/auth/passkeys')
    expect(list.status).toBe(200)
    expect(list.body.data.passkeys).toEqual([])

    const opts = await agent.post('/api/v1/auth/passkeys/register/options').set('x-csrf-token', csrf).send({ password: 'changeme' })
    expect(opts.status).toBe(200)
    expect(opts.body.data.challenge).toBeTruthy()
    expect(opts.body.data.rp.id).toBeTruthy()
    expect(opts.body.data.user.name).toBe('admin')
  })

  it('requires the current password to begin registration', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.post('/api/v1/auth/passkeys/register/options').set('x-csrf-token', csrf).send({ password: 'wrong' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('REAUTH_REQUIRED')
  })

  it('rejects a verify with no challenge in progress', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.post('/api/v1/auth/passkeys/login/verify').set('x-csrf-token', csrf)
      .send({ response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('NO_CHALLENGE')
  })

  it('404s when removing a passkey that does not exist', async () => {
    const { agent, csrf } = await loginAgent()
    const res = await agent.delete('/api/v1/auth/passkeys/999').set('x-csrf-token', csrf)
    expect(res.status).toBe(404)
  })
})
