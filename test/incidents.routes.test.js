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
    .send({ first_name: 'Inc', last_name: 'Subject', preferred_name: 'IS', ndis_number: '430000010' })
  clientId = client.body.data.id
})

describe('incident routes', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/incidents')
    expect(res.status).toBe(401)
  })

  it('creates, lists, exports and soft-deletes an incident report', async () => {
    const create = await agent.post('/api/v1/incidents').set('x-csrf-token', csrf).send({
      client_id: clientId, incident_date: '2026-06-01', incident_type: 'injury', severity: 'moderate',
      reportable: 1, reportable_category: 'serious_injury', description: 'Tripped on a step.', status: 'open'
    })
    expect(create.status).toBe(201)
    const id = create.body.data.id
    expect(create.body.data.description).toBe('Tripped on a step.')
    expect(create.body.data.client_display_name).toBe('IS')

    const list = await agent.get('/api/v1/incidents').query({ reportable: 'true' })
    expect(list.status).toBe(200)
    expect(list.body.data.some(i => i.id === id)).toBe(true)

    const stats = await agent.get('/api/v1/dashboard/stats')
    expect(stats.body.data.open_incident_reports).toBeGreaterThan(0)
    expect(stats.body.data.reportable_unreported).toBeGreaterThan(0)

    const followups = await agent.get('/api/v1/dashboard/incident-followups')
    expect(followups.body.data.some(i => i.id === id)).toBe(true)

    const pdf = await agent.get(`/api/v1/incidents/${id}/export.pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers['content-type']).toContain('pdf')

    const del = await agent.delete(`/api/v1/incidents/${id}`).set('x-csrf-token', csrf)
    expect(del.status).toBe(200)
    const after = await agent.get(`/api/v1/incidents/${id}`)
    expect(after.status).toBe(404)
  })

  it('promotes an incident-flagged shift note into a report', async () => {
    const shift = await agent.post('/api/v1/shifts').set('x-csrf-token', csrf).send({
      client_id: clientId, shift_date: '2026-06-05', incident_flag: 1, incident_details: 'Bumped head, no injury.'
    })
    expect(shift.status).toBe(201)
    const promote = await agent.post(`/api/v1/incidents/from-shift/${shift.body.data.id}`).set('x-csrf-token', csrf)
    expect(promote.status).toBe(201)
    expect(promote.body.data.shift_note_id).toBe(shift.body.data.id)
    expect(promote.body.data.description).toBe('Bumped head, no injury.')

    // A second promotion of the same note is rejected.
    const dup = await agent.post(`/api/v1/incidents/from-shift/${shift.body.data.id}`).set('x-csrf-token', csrf)
    expect(dup.status).toBe(409)
  })
})

describe('restrictive-practice and medication routes', () => {
  it('logs and lists a restrictive-practice record (narrative encrypted)', async () => {
    const create = await agent.post(`/api/v1/clients/${clientId}/restrictive-practices`).set('x-csrf-token', csrf)
      .send({ practice_type: 'environmental', used_at_date: '2026-06-02', authorised: 1, description: 'Locked the kitchen door.' })
    expect(create.status).toBe(201)
    const list = await agent.get(`/api/v1/clients/${clientId}/restrictive-practices`)
    expect(list.body.data.some(r => r.id === create.body.data.id)).toBe(true)
    expect(create.body.data.description).toBe('Locked the kitchen door.')
  })

  it('logs and lists a medication administration record', async () => {
    const create = await agent.post(`/api/v1/clients/${clientId}/medications`).set('x-csrf-token', csrf)
      .send({ medication_name: 'Paracetamol', dose: '500mg', route: 'oral', administered_date: '2026-06-02', status: 'administered', notes: 'After lunch.' })
    expect(create.status).toBe(201)
    expect(create.body.data.medication_name).toBe('Paracetamol')
    const list = await agent.get(`/api/v1/clients/${clientId}/medications`).query({ status: 'administered' })
    expect(list.body.data.some(m => m.id === create.body.data.id)).toBe(true)
  })
})
