import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'
import { freshDb } from './helpers/db.js'

let sqlite, rag, migrate, app, agent, uploadDir

beforeAll(async () => {
  // UPLOAD_PATH must be set before config is imported (inside freshDb).
  uploadDir = path.join(os.tmpdir(), `carelane-uploads-${process.pid}-${Date.now()}`)
  process.env.UPLOAD_PATH = uploadDir
  process.env.RERANK_ENABLED = 'false'
  ;({ sqlite, migrate } = await freshDb())
  rag = await import('../server/services/ragService.js')

  const { seed } = await import('../server/db/seed.js')
  seed()
  const { createApp } = await import('../server/app.js')
  app = createApp()
  agent = request.agent(app)
  await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'changeme' })
})

/** Insert a document plus chunks (FTS index is populated by triggers). */
function seedDoc ({ title, filename, chunks }) {
  const ts = new Date().toISOString()
  const { lastInsertRowid: id } = sqlite.prepare(
    "INSERT INTO documents (title, category, filename, original_name, indexed, created_at) VALUES (?, 'guideline', ?, ?, 1, ?)"
  ).run(title, filename, `${title}.pdf`, ts)
  const insert = sqlite.prepare(
    'INSERT INTO document_chunks (document_id, chunk_index, page, content, embedding, created_at) VALUES (?, ?, ?, ?, NULL, ?)'
  )
  chunks.forEach((content, i) => insert.run(id, i, i + 1, content, ts))
  return id
}

describe('ftsMatchQuery', () => {
  it('builds an OR-joined, quoted MATCH expression from alphanumeric terms', () => {
    expect(rag.ftsMatchQuery('NDIS price guide!')).toBe('"ndis" OR "price" OR "guide"')
  })
  it('drops single-character noise and returns null when nothing usable remains', () => {
    expect(rag.ftsMatchQuery('a # ?')).toBeNull()
  })
})

describe('rrfFuse', () => {
  it('ranks items appearing high in either list above singletons', () => {
    // id 2 appears in both lists (rank 2 and rank 1) → should win.
    const fused = rag.rrfFuse([[1, 2, 3], [2, 9]])
    expect(fused[0]).toBe(2)
    expect(fused).toContain(9)
  })
})

describe('keyword (BM25) search over FTS5', () => {
  beforeAll(() => {
    seedDoc({ title: 'Pricing Arrangements', filename: 'pricing.pdf', chunks: ['The travel claim rate for provider travel is capped per kilometre.'] })
    seedDoc({ title: 'Code of Conduct', filename: 'conduct.pdf', chunks: ['Workers must act with integrity, honesty and respect at all times.'] })
  })

  it('finds the chunk whose text matches the query terms', () => {
    const results = rag.keywordSearch('travel rate', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toBe('Pricing Arrangements')
  })

  it('does not match unrelated documents', () => {
    const results = rag.keywordSearch('travel rate', 5)
    expect(results.some(r => r.title === 'Code of Conduct')).toBe(false)
  })

  it('uses a self-contained FTS5 table (no external content) so re-index cannot corrupt it', () => {
    const sql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'document_chunks_fts'").get().sql
    expect(sql).not.toMatch(/content\s*=/)
  })

  it('keeps the index in sync when chunks are deleted (re-index path) without corruption', () => {
    const id = seedDoc({ title: 'Transient', filename: 'transient.pdf', chunks: ['unique kangaroo allowance clause'] })
    expect(rag.keywordSearch('kangaroo', 5).length).toBe(1)
    // Mirrors what indexDocument does first: delete the document's chunks.
    expect(() => sqlite.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id)).not.toThrow()
    expect(rag.keywordSearch('kangaroo', 5).length).toBe(0)
  })

  it('migrates an existing external-content FTS table to the self-contained form', () => {
    // Reproduce the old (fragile) external-content table + delete trigger.
    sqlite.exec(`
      DROP TRIGGER IF EXISTS document_chunks_ai;
      DROP TRIGGER IF EXISTS document_chunks_ad;
      DROP TRIGGER IF EXISTS document_chunks_au;
      DROP TABLE IF EXISTS document_chunks_fts;
      CREATE VIRTUAL TABLE document_chunks_fts USING fts5(content, content='document_chunks', content_rowid='id');
    `)
    expect(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='document_chunks_fts'").get().sql).toMatch(/content\s*=/)

    migrate() // should detect the external-content table and rebuild it

    const sql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='document_chunks_fts'").get().sql
    expect(sql).not.toMatch(/content\s*=/)
    // Backfilled from the base rows, and a delete still works cleanly.
    expect(rag.keywordSearch('travel', 5).length).toBeGreaterThan(0)
    expect(() => migrate()).not.toThrow() // idempotent second run
  })
})

describe('embedding-model drift warning', () => {
  it('warns once per stale document and clears when re-stamped to the current model', async () => {
    const config = (await import('../server/config.js')).default
    const { logger } = await import('../server/services/logger.js')
    const id = seedDoc({ title: 'Stale doc', filename: 'stale.pdf', chunks: ['anything'] })
    // seedDoc leaves embedding_model NULL → counts as stale.
    let warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    rag.checkEmbeddingModel()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    sqlite.prepare('UPDATE documents SET embedding_model = ? WHERE id = ?').run(config.embeddingModel, id)
    // Re-stamp every other seeded doc too so none remain stale.
    sqlite.prepare('UPDATE documents SET embedding_model = ? WHERE indexed = 1').run(config.embeddingModel)
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    rag.checkEmbeddingModel()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('document download route', () => {
  it('streams the original PDF for an authenticated user', async () => {
    const dir = path.join(uploadDir, 'documents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'download-me.pdf'), '%PDF-1.4 test')
    const id = seedDoc({ title: 'Downloadable', filename: 'download-me.pdf', chunks: ['x'] })

    const res = await agent.get(`/api/v1/documents/${id}/file`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('Downloadable.pdf')
  })

  it('404s for a missing document', async () => {
    const res = await agent.get('/api/v1/documents/999999/file')
    expect(res.status).toBe(404)
  })
})
