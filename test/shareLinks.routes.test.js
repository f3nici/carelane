import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

// Coverage for client-facing share links: an admin mints a time-limited,
// read-only link to a finalised report; the public `/share/:token` landing page
// and `/share/:token/download` fetch work without a session; each download is
// counted; and expiry / view-limit / revocation all close the link. Workers may
// not create links, and only finalised reports can be shared.

let app
let sqlite
let admin, worker
let adminClient, workerClient
let finalReport

/** Log in through a fresh agent and return { agent, csrf }. */
async function loginAgent (username, password) {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/login').send({ username, password })
  return { agent, csrf: res.body.data.csrf_token }
}

/** Pull the token out of a share URL like http://…/share/<token>. */
const tokenOf = url => url.match(/\/share\/([^/]+)$/)[1]

beforeAll(async () => {
  const dbc = await freshDb()
  sqlite = dbc.sqlite
  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()

  admin = await loginAgent('admin', 'changeme')

  adminClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Ada', last_name: 'Admin', preferred_name: 'Ada', ndis_number: '451000001' })).body.data
  workerClient = (await admin.agent.post('/api/v1/clients').set('x-csrf-token', admin.csrf)
    .send({ first_name: 'Wanda', last_name: 'Worker', preferred_name: 'Wanda', ndis_number: '451000002' })).body.data

  // A worker login assigned to workerClient.
  const created = (await admin.agent.post('/api/v1/users').set('x-csrf-token', admin.csrf)
    .send({ username: 'shworker', display_name: 'SH Worker', password: 'worker-pass-123', role: 'worker' })).body.data
  await admin.agent.put(`/api/v1/users/${created.id}/clients`).set('x-csrf-token', admin.csrf)
    .send({ client_ids: [workerClient.id] })
  worker = await loginAgent('shworker', 'worker-pass-123')

  // A finalised report with a body, ready to share.
  finalReport = (await admin.agent.post('/api/v1/reports').set('x-csrf-token', admin.csrf)
    .send({ client_id: adminClient.id, report_type: 'progress', period_start: '2026-06-01', period_end: '2026-06-30', body_markdown: '# Progress\nAda did well this month.', status: 'final' })).body.data
})

/** Create a share link as admin; returns the link record (with url). */
async function createLink (body) {
  const res = await admin.agent.post('/api/v1/share-links').set('x-csrf-token', admin.csrf)
    .send({ resource_type: 'report', resource_id: finalReport.id, client_id: adminClient.id, ...body })
  return res
}

describe('client-facing share links', () => {
  it('creates a share link for a finalised report and serves a public landing page', async () => {
    const res = await createLink({ label: 'Plan manager', expires_in_days: 30 })
    expect(res.status).toBe(201)
    expect(res.body.data.url).toMatch(/\/share\/[A-Za-z0-9_-]+$/)
    expect(res.body.data.state).toBe('active')

    const landing = await request(app).get(`/share/${tokenOf(res.body.data.url)}`)
    expect(landing.status).toBe(200)
    expect(landing.headers['content-type']).toMatch(/text\/html/)
    // Landing shows a safe descriptor + participant label, never report content.
    expect(landing.text).toContain('progress report')
    expect(landing.text).toContain('Ada')
    expect(landing.text).not.toContain('Ada did well this month')
    // Viewing the landing page does not count as a download.
    const listed = (await admin.agent.get('/api/v1/share-links')
      .query({ resource_type: 'report', resource_id: finalReport.id })).body.data
      .find(l => l.id === res.body.data.id)
    expect(listed.view_count).toBe(0)
  })

  it('downloads the shared report PDF and counts the access', async () => {
    const created = (await createLink({})).body.data
    const dl = await request(app).get(`/share/${tokenOf(created.url)}/download`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-type']).toMatch(/application\/pdf/)
    expect(dl.headers['content-disposition']).toMatch(/attachment/)

    const after = (await admin.agent.get('/api/v1/share-links')
      .query({ resource_type: 'report', resource_id: finalReport.id })).body.data
      .find(l => l.id === created.id)
    expect(after.view_count).toBe(1)
    expect(after.last_viewed_at).toBeTruthy()
  })

  it('records each access in the append-only audit trail without breaking the chain', async () => {
    const created = (await createLink({})).body.data
    await request(app).get(`/share/${tokenOf(created.url)}/download`)
    const audit = await admin.agent.get('/api/v1/audit')
      .query({ entity_type: 'share_link', action: 'accessed' })
    expect(audit.status).toBe(200)
    expect(audit.body.data.some(r => r.entity_id === created.id)).toBe(true)
    const verify = await admin.agent.get('/api/v1/audit/verify')
    expect(verify.body.data.valid).toBe(true)
  })

  it('enforces a max-download cap (exhausted after the limit)', async () => {
    const created = (await createLink({ max_views: 1 })).body.data
    const first = await request(app).get(`/share/${tokenOf(created.url)}/download`)
    expect(first.status).toBe(200)
    const second = await request(app).get(`/share/${tokenOf(created.url)}/download`)
    expect(second.status).toBe(410)
    // The landing page for an exhausted link is also closed.
    expect((await request(app).get(`/share/${tokenOf(created.url)}`)).status).toBe(410)
  })

  it('closes an expired link', async () => {
    const created = (await createLink({})).body.data
    // Backdate expiry directly to simulate the clock passing.
    sqlite.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', created.id)
    expect((await request(app).get(`/share/${tokenOf(created.url)}`)).status).toBe(410)
    expect((await request(app).get(`/share/${tokenOf(created.url)}/download`)).status).toBe(410)
  })

  it('revokes a link so existing URLs stop working', async () => {
    const created = (await createLink({})).body.data
    const rev = await admin.agent.post(`/api/v1/share-links/${created.id}/revoke`).set('x-csrf-token', admin.csrf)
    expect(rev.body.data.state).toBe('revoked')
    expect((await request(app).get(`/share/${tokenOf(created.url)}/download`)).status).toBe(410)
  })

  it('404s an unknown token', async () => {
    expect((await request(app).get('/share/not-a-real-token')).status).toBe(404)
    expect((await request(app).get('/share/not-a-real-token/download')).status).toBe(404)
  })

  it('shares a PDF document and streams the stored file', async () => {
    const doc = (await admin.agent.post(`/api/v1/clients/${adminClient.id}/documents`).set('x-csrf-token', admin.csrf)
      .field('title', 'Signed consent')
      .field('doc_type', 'consent_general')
      .attach('file', Buffer.from('%PDF-1.4 signed consent'), 'consent.pdf')).body.data
    const created = (await admin.agent.post('/api/v1/share-links').set('x-csrf-token', admin.csrf)
      .send({ resource_type: 'client_document', resource_id: doc.id, client_id: adminClient.id })).body.data
    const dl = await request(app).get(`/share/${tokenOf(created.url)}/download`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-type']).toMatch(/application\/pdf/)
    expect(dl.headers['content-disposition']).toMatch(/attachment/)
  })

  it('refuses to share a non-PDF document', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const doc = (await admin.agent.post(`/api/v1/clients/${adminClient.id}/documents`).set('x-csrf-token', admin.csrf)
      .field('title', 'Scanned ID')
      .field('doc_type', 'identification')
      .attach('file', png, 'id.png')).body.data
    const res = await admin.agent.post('/api/v1/share-links').set('x-csrf-token', admin.csrf)
      .send({ resource_type: 'client_document', resource_id: doc.id, client_id: adminClient.id })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_PDF')
  })

  it('refuses to share a draft report', async () => {
    const draft = (await admin.agent.post('/api/v1/reports').set('x-csrf-token', admin.csrf)
      .send({ client_id: adminClient.id, report_type: 'progress', body_markdown: 'draft', status: 'draft' })).body.data
    const res = await admin.agent.post('/api/v1/share-links').set('x-csrf-token', admin.csrf)
      .send({ resource_type: 'report', resource_id: draft.id, client_id: adminClient.id })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_FINAL')
  })

  it('rejects a resource that does not belong to the named participant', async () => {
    const res = await admin.agent.post('/api/v1/share-links').set('x-csrf-token', admin.csrf)
      .send({ resource_type: 'report', resource_id: finalReport.id, client_id: workerClient.id })
    expect(res.status).toBe(400)
  })

  it('forbids a support worker from creating or listing share links', async () => {
    expect((await worker.agent.post('/api/v1/share-links').set('x-csrf-token', worker.csrf)
      .send({ resource_type: 'report', resource_id: finalReport.id, client_id: adminClient.id })).status).toBe(403)
    expect((await worker.agent.get('/api/v1/share-links')).status).toBe(403)
  })

  it('requires authentication to manage share links', async () => {
    expect((await request(app).get('/api/v1/share-links')).status).toBe(401)
  })
})
