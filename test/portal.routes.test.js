import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

// Coverage for the client portal: an admin grants a participant a read-only
// portal login; the participant can list/view ONLY their own finalised shift
// notes and documents; drafts, billing and incident detail are never exposed;
// and the portal session is fully isolated from the staff app (and vice versa).

let app
let admin
let clientA, clientB
let finalisedNote, draftNote, incidentNote, otherNote, docA

const PORTAL_USER = 'aishaportal'
const PORTAL_PASS = 'portal-pass-123'

async function loginAgent (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data.csrf_token }
}

/** Create a shift note as admin (defaults to finalised). */
async function createNote (over) {
  return (await admin.agent.post('/api/v1/shifts').set('x-csrf-token', admin.csrf)
    .send({ shift_date: '2026-06-10', start_time: '09:00', end_time: '12:00', finalised: 1, ...over })).body.data
}

beforeAll(async () => {
  await freshDb()
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()

  admin = await loginAgent('admin', 'changeme')

  clientA = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Portal', last_name: 'Participant', preferred_name: 'Pat', ndis_number: '452000001' })).body.data
  clientB = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Other', last_name: 'Person', preferred_name: 'Otto', ndis_number: '452000002' })).body.data

  finalisedNote = await createNote({ client_id: clientA.id, body: 'Went to the park and had a lovely time.', support_provided: 'Community access' })
  draftNote = await createNote({ client_id: clientA.id, body: 'Draft note not yet complete.', finalised: 0 })
  incidentNote = await createNote({ client_id: clientA.id, body: 'General narrative of the shift.', incident_flag: 1, incident_details: 'A minor slip in the kitchen; first aid applied and the participant was fine.' })
  otherNote = await createNote({ client_id: clientB.id, body: 'Belongs to a different participant.' })

  docA = (await admin.agent.post(`/api/v1/clients/${clientA.id}/documents`).set('x-csrf-token', admin.csrf)
    .field('title', 'Consent form')
    .field('doc_type', 'media_consent')
    .attach('file', Buffer.from('%PDF-1.4 consent'), 'consent.pdf')).body.data

  // Grant clientA a portal login.
  await admin.agent.put(`/api/v1/clients/${clientA.id}/portal-account`).set('x-csrf-token', admin.csrf)
    .send({ username: PORTAL_USER, password: PORTAL_PASS })
})

/** Log in through a fresh portal agent (CSRF-exempt like the staff login). */
async function portalLogin (username = PORTAL_USER, password = PORTAL_PASS) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/portal/auth/login').send({ username, password })
  return { agent, res }
}

describe('client portal', () => {
  it('admin grants a portal login and rejects a duplicate username on another participant', async () => {
    const acct = (await admin.agent.get(`/api/v1/clients/${clientA.id}/portal-account`)).body.data
    expect(acct.username).toBe(PORTAL_USER)
    expect(acct.active).toBe(true)

    const clash = await admin.agent.put(`/api/v1/clients/${clientB.id}/portal-account`).set('x-csrf-token', admin.csrf)
      .send({ username: PORTAL_USER, password: 'another-pass-123' })
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('USERNAME_TAKEN')
  })

  it('logs in and returns the participant label + a CSRF token', async () => {
    const { res } = await portalLogin()
    expect(res.status).toBe(200)
    expect(res.body.data.client_id).toBe(clientA.id)
    expect(res.body.data.participant_label).toBe('Pat')
    expect(res.body.data.csrf_token).toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    const { res } = await portalLogin(PORTAL_USER, 'wrong-password')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('lists only the participant\'s finalised notes (no drafts, no other participant)', async () => {
    const { agent } = await portalLogin()
    const list = await agent.get('/api/v1/portal/shift-notes')
    expect(list.status).toBe(200)
    const ids = list.body.data.map(n => n.id)
    expect(ids).toContain(finalisedNote.id)
    expect(ids).toContain(incidentNote.id)
    expect(ids).not.toContain(draftNote.id)
    expect(ids).not.toContain(otherNote.id)
  })

  it('shows the incident narrative on the participant\'s own note but never billing', async () => {
    const { agent } = await portalLogin()
    const detail = await agent.get(`/api/v1/portal/shift-notes/${incidentNote.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.body).toContain('General narrative')
    expect(detail.body.data.incident_flag).toBe(true)
    // The participant sees the incident narrative on their own note …
    expect(detail.body.data.incident_details).toContain('minor slip in the kitchen')
    // … but billing is still never serialised.
    expect(detail.body.data).not.toHaveProperty('billed')
  })

  it('404s a draft or another participant\'s note by id', async () => {
    const { agent } = await portalLogin()
    expect((await agent.get(`/api/v1/portal/shift-notes/${draftNote.id}`)).status).toBe(404)
    expect((await agent.get(`/api/v1/portal/shift-notes/${otherNote.id}`)).status).toBe(404)
  })

  it('lists and downloads the participant\'s documents', async () => {
    const { agent } = await portalLogin()
    const docs = await agent.get('/api/v1/portal/documents')
    expect(docs.status).toBe(200)
    expect(docs.body.data.map(d => d.id)).toContain(docA.id)

    const dl = await agent.get(`/api/v1/portal/documents/${docA.id}/file`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-disposition']).toMatch(/attachment/)
  })

  it('isolates a portal session from the staff API', async () => {
    const { agent } = await portalLogin()
    // A portal session has no staff userId — every staff route rejects it.
    expect((await agent.get('/api/v1/clients')).status).toBe(401)
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401)
  })

  it('isolates the staff session from the portal API', async () => {
    // A staff session has no portalClientId — portal routes reject it.
    expect((await admin.agent.get('/api/v1/portal/shift-notes')).status).toBe(401)
    expect((await admin.agent.get('/api/v1/portal/auth/me')).status).toBe(401)
  })

  it('requires a portal session for portal data', async () => {
    expect((await request(app).get('/api/v1/portal/shift-notes')).status).toBe(401)
    expect((await request(app).get('/api/v1/portal/documents')).status).toBe(401)
  })

  it('deactivating the account blocks new logins and revokes live sessions', async () => {
    const { agent } = await portalLogin()
    expect((await agent.get('/api/v1/portal/auth/me')).status).toBe(200)

    await admin.agent.put(`/api/v1/clients/${clientA.id}/portal-account`).set('x-csrf-token', admin.csrf)
      .send({ username: PORTAL_USER, active: 0 })

    // The live session no longer resolves, and a fresh login is refused.
    expect((await agent.get('/api/v1/portal/auth/me')).status).toBe(401)
    expect((await portalLogin()).res.status).toBe(401)

    // Re-enable for any later assertions.
    await admin.agent.put(`/api/v1/clients/${clientA.id}/portal-account`).set('x-csrf-token', admin.csrf)
      .send({ username: PORTAL_USER, active: 1 })
    expect((await portalLogin()).res.status).toBe(200)
  })

  it('forbids a support worker from managing portal accounts', async () => {
    const created = (await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
      .send({ username: 'ptlworker', display_name: 'PW', password: 'worker-pass-123', role: 'worker' })).body.data
    await admin.agent.put(`/api/v1/users/${created.id}/clients`).set('x-csrf-token', admin.csrf)
      .send({ client_ids: [clientA.id] })
    const worker = await loginAgent('ptlworker', 'worker-pass-123')

    expect((await worker.agent.get(`/api/v1/clients/${clientA.id}/portal-account`)).status).toBe(403)
    expect((await worker.agent.put(`/api/v1/clients/${clientA.id}/portal-account`).set('x-csrf-token', worker.csrf)
      .send({ username: 'sneaky', password: 'sneaky-pass-123' })).status).toBe(403)
  })
})
