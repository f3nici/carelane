import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

let app, agent, csrf

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed() // seeds the admin user + starter default templates
  const { createApp } = await import('../server/app.js')
  app = createApp()
  agent = request.agent(app)
  const login = await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
  csrf = login.body.data.csrf_token
})

describe('templates routes', () => {
  it('lists the seeded starter templates', async () => {
    const res = await agent.get('/api/v1/templates')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThanOrEqual(2)
    expect(res.body.data.some(t => t.template_type === 'agreement')).toBe(true)
  })

  it('creates, updates and soft-deletes a template', async () => {
    const create = await agent.post('/api/v1/templates').set('x-csrf-token', csrf).send({
      name: 'Custom agreement', template_type: 'agreement', body_markdown: '# Service Agreement\n## Parties'
    })
    expect(create.status).toBe(201)
    const id = create.body.data.id

    const update = await agent.put(`/api/v1/templates/${id}`).set('x-csrf-token', csrf).send({ name: 'Renamed' })
    expect(update.status).toBe(200)
    expect(update.body.data.name).toBe('Renamed')

    const del = await agent.delete(`/api/v1/templates/${id}`).set('x-csrf-token', csrf)
    expect(del.status).toBe(200)

    const after = await agent.get(`/api/v1/templates/${id}`)
    expect(after.status).toBe(404)
  })

  it('rejects an invalid template type', async () => {
    const res = await agent.post('/api/v1/templates').set('x-csrf-token', csrf).send({
      name: 'Bad', template_type: 'invoice', body_markdown: '# X'
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
