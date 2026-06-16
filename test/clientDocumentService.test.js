import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let docService, clientService, deletedService

beforeAll(async () => {
  await freshDb()
  docService = await import('../server/services/clientDocumentService.js')
  clientService = await import('../server/services/clientService.js')
  deletedService = await import('../server/services/deletedService.js')
})

const file = (name = 'consent.pdf') => ({ filename: 'stored-' + name, originalname: name, mimetype: 'application/pdf', size: 1234 })
const makeClient = () => clientService.createClient({ first_name: 'Doc', last_name: 'Holder', preferred_name: 'DH', active: 1 })

describe('clientDocumentService — consent & expiry tracking', () => {
  it('classifies a document with a type, issue and expiry date', () => {
    const c = makeClient()
    const doc = docService.createClientDocument(c.id, file(), {
      title: 'Media consent', doc_type: 'media_consent', issue_date: '2026-01-01', expiry_date: '2099-01-01'
    })
    expect(doc.doc_type).toBe('media_consent')
    expect(doc.issue_date).toBe('2026-01-01')
    expect(doc.expiry_status).toBe('ok')
  })

  it('falls back to "other" for an unknown type and ignores bad dates', () => {
    const c = makeClient()
    const doc = docService.createClientDocument(c.id, file(), { doc_type: 'nonsense', issue_date: 'not-a-date' })
    expect(doc.doc_type).toBe('other')
    expect(doc.issue_date).toBeNull()
  })

  it('flags expired and soon-to-expire documents', () => {
    expect(docService.expiryStatus('2020-01-01')).toBe('expired')
    expect(docService.expiryStatus('2099-01-01')).toBe('ok')
    expect(docService.expiryStatus(null)).toBeNull()
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(docService.expiryStatus(soon)).toBe('expiring')
  })

  it('surfaces expiring/expired documents across clients', () => {
    const c = makeClient()
    docService.createClientDocument(c.id, file(), { title: 'Lapsed consent', doc_type: 'consent_to_share', expiry_date: '2020-01-01' })
    const expiring = docService.listExpiringDocuments(90)
    const found = expiring.find(d => d.title === 'Lapsed consent')
    expect(found).toBeTruthy()
    expect(found.expiry_status).toBe('expired')
    expect(found.client_display_name).toBe('DH')
    expect(docService.countExpiringDocuments(90)).toBeGreaterThan(0)
  })

  it('updates metadata without re-uploading the file', () => {
    const c = makeClient()
    const doc = docService.createClientDocument(c.id, file(), { title: 'Plain upload', doc_type: 'other' })
    const updated = docService.updateClientDocument(c.id, doc.id, { doc_type: 'risk_assessment', expiry_date: '2027-06-01' })
    expect(updated.doc_type).toBe('risk_assessment')
    expect(updated.expiry_date).toBe('2027-06-01')
  })

  it('soft-deletes and restores a document via the deleted registry', () => {
    const c = makeClient()
    const doc = docService.createClientDocument(c.id, file(), { title: 'Bin me', doc_type: 'insurance' })
    docService.deleteClientDocument(c.id, doc.id)
    expect(() => docService.getClientDocument(c.id, doc.id)).toThrow(/not found/i)

    const entry = deletedService.listDeleted().find(i => i.entity_type === 'client_document' && i.id === doc.id)
    expect(entry).toBeTruthy()
    expect(entry.label).toBe('Bin me')

    deletedService.restoreDeleted('client_document', doc.id)
    expect(docService.getClientDocument(c.id, doc.id).id).toBe(doc.id)
  })
})
