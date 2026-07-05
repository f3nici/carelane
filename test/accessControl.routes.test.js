import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

// End-to-end coverage for multi-user access control: an admin creates a worker,
// assigns them one participant, and we assert the worker can see/note that
// participant + their own roster but cannot reach an unassigned participant,
// edit finalised notes, or touch operator-only surfaces.

let app
let admin, worker
let assignedClient, otherClient
let assignedScheduled, otherScheduled

/** Log in through a fresh agent and return { agent, csrf }. */
async function loginAgent (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data.csrf_token }
}

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()

  admin = await loginAgent('admin', 'changeme')

  // Two participants.
  assignedClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Ada', last_name: 'Assigned', ndis_number: '431000001' })).body.data
  otherClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Otto', last_name: 'Other', ndis_number: '431000002' })).body.data

  // A worker login, assigned only to assignedClient.
  const created = await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
    .send({ username: 'worker1', display_name: 'Worker One', password: 'worker-pass-123', role: 'worker' })
  const workerId = created.body.data.id
  await admin.agent.put(`/api/v1/users/${workerId}/clients`).set('x-csrf-token', admin.csrf)
    .send({ client_ids: [assignedClient.id] })

  // A rostered shift for each participant, assigned to the worker / to the admin.
  assignedScheduled = (await admin.agent.post('/api/v1/schedule').set('x-csrf-token', admin.csrf)
    .send({ client_id: assignedClient.id, worker_id: workerId, scheduled_date: '2026-09-01', start_time: '09:00', end_time: '11:00' })).body.data
  otherScheduled = (await admin.agent.post('/api/v1/schedule').set('x-csrf-token', admin.csrf)
    .send({ client_id: otherClient.id, scheduled_date: '2026-09-02', start_time: '09:00', end_time: '11:00' })).body.data

  worker = await loginAgent('worker1', 'worker-pass-123')
}, 30000) // generous: the setup does several cost-12 bcrypt hashes/compares

describe('multi-user access control', () => {
  it('logs the worker in with the worker role', async () => {
    const me = await worker.agent.get('/api/v1/auth/me')
    expect(me.body.data.role).toBe('worker')
  })

  it('scopes the client list to assigned participants only', async () => {
    const res = await worker.agent.get('/api/v1/clients')
    const ids = res.body.data.map(c => c.id)
    expect(ids).toContain(assignedClient.id)
    expect(ids).not.toContain(otherClient.id)
  })

  it('lets the worker read an assigned participant but denies an unassigned one', async () => {
    expect((await worker.agent.get(`/api/v1/clients/${assignedClient.id}`)).status).toBe(200)
    const denied = await worker.agent.get(`/api/v1/clients/${otherClient.id}`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.message).toMatch(/don't have access/i)
  })

  it('forbids the worker creating or editing participants', async () => {
    const create = await worker.agent.post('/api/v1/clients').set('x-csrf-token', worker.csrf)
      .send({ first_name: 'No', last_name: 'Way', ndis_number: '431000003' })
    expect(create.status).toBe(403)
    const edit = await worker.agent.put(`/api/v1/clients/${assignedClient.id}`).set('x-csrf-token', worker.csrf)
      .send({ preferred_name: 'Nope' })
    expect(edit.status).toBe(403)
  })

  it('lets the worker create a note for an assigned participant but not an unassigned one', async () => {
    const ok = await worker.agent.post('/api/v1/shifts').set('x-csrf-token', worker.csrf)
      .send({ client_id: assignedClient.id, shift_date: '2026-09-01', body: 'Supported with shopping.' })
    expect(ok.status).toBe(201)

    const denied = await worker.agent.post('/api/v1/shifts').set('x-csrf-token', worker.csrf)
      .send({ client_id: otherClient.id, shift_date: '2026-09-01', body: 'Should be blocked.' })
    expect(denied.status).toBe(403)
  })

  it('lets the worker edit and finalise their own draft, then locks it', async () => {
    const draft = (await worker.agent.post('/api/v1/shifts').set('x-csrf-token', worker.csrf)
      .send({ client_id: assignedClient.id, shift_date: '2026-09-04', body: 'Draft note.' })).body.data
    expect(draft.finalised).toBe(0)
    // Edit the draft…
    const edited = await worker.agent.put(`/api/v1/shifts/${draft.id}`).set('x-csrf-token', worker.csrf)
      .send({ body: 'Edited by the worker.' })
    expect(edited.status).toBe(200)
    // …then finalise it themselves…
    const finalised = await worker.agent.put(`/api/v1/shifts/${draft.id}`).set('x-csrf-token', worker.csrf)
      .send({ finalised: 1 })
    expect(finalised.status).toBe(200)
    expect(finalised.body.data.finalised).toBe(1)
    // …after which they can no longer edit it or send it back to draft.
    const reopen = await worker.agent.put(`/api/v1/shifts/${draft.id}`).set('x-csrf-token', worker.csrf)
      .send({ finalised: 0 })
    expect(reopen.status).toBe(403)
  })

  it('lets the worker view but not edit, delete or reopen someone else\'s note', async () => {
    // Admin finalises a note for the assigned participant.
    const note = (await admin.agent.post('/api/v1/shifts').set('x-csrf-token', admin.csrf)
      .send({ client_id: assignedClient.id, shift_date: '2026-09-03', body: 'Admin note.', finalised: 1 })).body.data
    // Worker can read it…
    expect((await worker.agent.get(`/api/v1/shifts/${note.id}`)).status).toBe(200)
    // …but cannot edit or send it back to draft.
    const edit = await worker.agent.put(`/api/v1/shifts/${note.id}`).set('x-csrf-token', worker.csrf)
      .send({ finalised: 0 })
    expect(edit.status).toBe(403)
    const del = await worker.agent.delete(`/api/v1/shifts/${note.id}`).set('x-csrf-token', worker.csrf)
    expect(del.status).toBe(403)
  })

  it('shows the worker only their own roster', async () => {
    const res = await worker.agent.get('/api/v1/schedule').query({ from: '2026-08-01', to: '2026-09-30' })
    const ids = res.body.data.map(s => s.id)
    expect(ids).toContain(assignedScheduled.id)
    expect(ids).not.toContain(otherScheduled.id)
  })

  it('lets the worker clock in to their own shift but not another worker/admin shift', async () => {
    const mine = await worker.agent.post(`/api/v1/schedule/${assignedScheduled.id}/clock-in`).set('x-csrf-token', worker.csrf)
    expect(mine.body.data.status).toBe('in_progress')
    const notMine = await worker.agent.post(`/api/v1/schedule/${otherScheduled.id}/clock-in`).set('x-csrf-token', worker.csrf)
    expect(notMine.status).toBe(403)
  })

  it('forbids the worker rostering or deleting shifts', async () => {
    const create = await worker.agent.post('/api/v1/schedule').set('x-csrf-token', worker.csrf)
      .send({ client_id: assignedClient.id, scheduled_date: '2026-09-10' })
    expect(create.status).toBe(403)
    const del = await worker.agent.delete(`/api/v1/schedule/${assignedScheduled.id}`).set('x-csrf-token', worker.csrf)
    expect(del.status).toBe(403)
  })

  it('blocks the worker from operator-only surfaces and user management', async () => {
    for (const path of ['/api/v1/users', '/api/v1/audit/verify', '/api/v1/deleted', '/api/v1/invoices', '/api/v1/settings/backups']) {
      expect((await worker.agent.get(path)).status).toBe(403)
    }
    // Settings *reads* (branding + AI status) are allowed for the app to work;
    // writing settings is not.
    expect((await worker.agent.get('/api/v1/settings')).status).toBe(200)
    expect((await worker.agent.get('/api/v1/settings/ai/status')).status).toBe(200)
    const write = await worker.agent.put('/api/v1/settings').set('x-csrf-token', worker.csrf).send({ business_name: 'Nope' })
    expect(write.status).toBe(403)
  })

  it('lets the worker read/search the knowledge base but not upload/delete documents', async () => {
    expect((await worker.agent.get('/api/v1/documents')).status).toBe(200)
    expect((await worker.agent.get('/api/v1/documents/search').query({ q: 'ndis', mode: 'keyword' })).status).toBe(200)
    // Grounded Q&A is available to workers too — access is granted (the AI is
    // unconfigured in tests, so it fails with 503, never 403).
    const ask = await worker.agent.post('/api/v1/documents/ask').set('x-csrf-token', worker.csrf).send({ question: 'What is a support plan?' })
    expect(ask.status).not.toBe(403)
    // Downloading a source document is allowed (a missing id 404s, never 403).
    expect((await worker.agent.get('/api/v1/documents/999999/file')).status).not.toBe(403)
    // Uploading and deleting knowledge-base documents stays admin-only.
    const upload = await worker.agent.post('/api/v1/documents').set('x-csrf-token', worker.csrf)
      .field('title', 'nope')
    expect(upload.status).toBe(403)
    const del = await worker.agent.delete('/api/v1/documents/1').set('x-csrf-token', worker.csrf)
    expect(del.status).toBe(403)
  })

  it('hides the participant charge rate and service agreements from the worker', async () => {
    // Admin links a billing code with a per-participant charge rate.
    await admin.agent.put(`/api/v1/clients/${assignedClient.id}/billing-codes`).set('x-csrf-token', admin.csrf)
      .send({ codes: [{ billing_code_id: 1, custom_rate: 99.5 }] })
    // Admin sees the rate…
    const adminView = await admin.agent.get(`/api/v1/clients/${assignedClient.id}/billing-codes`)
    expect(adminView.body.data[0].custom_rate).toBe(99.5)
    // …the worker sees the code (to pick it on a note) but not the rate/caps.
    const workerView = await worker.agent.get(`/api/v1/clients/${assignedClient.id}/billing-codes`)
    expect(workerView.status).toBe(200)
    expect(workerView.body.data[0].code).toBeTruthy()
    expect(workerView.body.data[0].custom_rate).toBeUndefined()
    expect(workerView.body.data[0].price_cap_standard).toBeUndefined()
    // Service agreements are hidden entirely.
    expect((await worker.agent.get('/api/v1/agreements')).status).toBe(403)
    expect((await worker.agent.get(`/api/v1/clients/${assignedClient.id}/agreements`)).status).toBe(403)
    // …and the full-record export (which includes agreements + rates) is admin-only.
    expect((await worker.agent.get(`/api/v1/clients/${assignedClient.id}/export`)).status).toBe(403)
  })

  it('lets the worker AI-draft their own draft note but not someone else\'s', async () => {
    const draft = (await worker.agent.post('/api/v1/shifts').set('x-csrf-token', worker.csrf)
      .send({ client_id: assignedClient.id, shift_date: '2026-09-06', support_provided: '- helped with shopping' })).body.data
    // Access is granted (the AI is unconfigured in tests → 503, never 403).
    const own = await worker.agent.post(`/api/v1/shifts/${draft.id}/draft`).set('x-csrf-token', worker.csrf)
      .send({ bullets: '- helped with shopping' })
    expect(own.status).not.toBe(403)
    // An admin-owned note is off-limits to the worker's AI draft.
    const adminNote = (await admin.agent.post('/api/v1/shifts').set('x-csrf-token', admin.csrf)
      .send({ client_id: assignedClient.id, shift_date: '2026-09-07', support_provided: '- admin' })).body.data
    const other = await worker.agent.post(`/api/v1/shifts/${adminNote.id}/draft`).set('x-csrf-token', worker.csrf)
      .send({ bullets: '- x' })
    expect(other.status).toBe(403)
  })

  it('lets the worker read billing codes (needed to note a shift) but not edit them', async () => {
    expect((await worker.agent.get('/api/v1/billing-codes')).status).toBe(200)
    const edit = await worker.agent.post('/api/v1/billing-codes').set('x-csrf-token', worker.csrf)
      .send({ code: 'X', name: 'Nope' })
    expect(edit.status).toBe(403)
  })

  it('scopes the worker dashboard to their assignments', async () => {
    const res = await worker.agent.get('/api/v1/dashboard/stats')
    // Only one participant is assigned to this worker.
    expect(res.body.data.active_clients).toBe(1)
  })

  it('immediately blocks a deactivated worker', async () => {
    const created = await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
      .send({ username: 'worker2', display_name: 'Worker Two', password: 'worker-pass-456', role: 'worker' })
    const w2 = await loginAgent('worker2', 'worker-pass-456')
    expect((await w2.agent.get('/api/v1/clients')).status).toBe(200)
    await admin.agent.put(`/api/v1/users/${created.body.data.id}`).set('x-csrf-token', admin.csrf).send({ active: 0 })
    // The next request on the still-live cookie is rejected.
    expect((await w2.agent.get('/api/v1/clients')).status).toBe(401)
  })

  it('refuses to demote the last admin', async () => {
    const me = await admin.agent.get('/api/v1/auth/me')
    const res = await admin.agent.put(`/api/v1/users/${me.body.data.id}`).set('x-csrf-token', admin.csrf)
      .send({ role: 'worker' })
    expect(res.status).toBe(409)
  })
})
