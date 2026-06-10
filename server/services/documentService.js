import fs from 'node:fs'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'
import { indexDocument } from './ragService.js'
import config from '../config.js'

const now = () => new Date().toISOString()

/**
 * Extract text per page from a PDF buffer (fully local).
 * @param {Buffer} buffer
 * @returns {Promise<{pages:string[], pageCount:number}>}
 */
export async function extractPdfPages (buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText()
    const pages = (result.pages || []).map(p => p.text || '')
    return { pages, pageCount: result.total ?? pages.length }
  } finally {
    await parser.destroy()
  }
}

/**
 * List knowledge-base documents with chunk counts.
 */
export function listDocuments () {
  return sqlite.prepare(`SELECT d.*, (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) AS chunk_count
    FROM documents d ORDER BY d.created_at DESC`).all()
}

/**
 * Fetch one document or throw 404.
 * @param {number} id
 */
export function getDocument (id) {
  const row = sqlite.prepare('SELECT * FROM documents WHERE id = ?').get(id)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Document not found')
  return row
}

/**
 * Register an uploaded PDF and index it in the background (chunk + local
 * embeddings). Returns the row immediately with `indexed=0`.
 * @param {{filename:string, originalname:string}} file multer file
 * @param {{title?:string, category?:string}} meta
 */
export function createDocument (file, meta) {
  const result = sqlite.prepare(`INSERT INTO documents (title, category, filename, original_name, indexed, created_at)
    VALUES (?, ?, ?, ?, 0, ?)`)
    .run(meta.title || file.originalname, meta.category || 'guideline', file.filename, file.originalname, now())
  const id = result.lastInsertRowid
  reindexDocument(id).catch(err => console.error(`indexing document ${id} failed:`, err.message))
  return getDocument(id)
}

/**
 * (Re-)index a document: extract pages, chunk, embed locally.
 * @param {number} id
 * @returns {Promise<number>} chunk count
 */
export async function reindexDocument (id) {
  const doc = getDocument(id)
  const buffer = fs.readFileSync(path.join(config.uploadPath, 'documents', doc.filename))
  const { pages, pageCount } = await extractPdfPages(buffer)
  sqlite.prepare('UPDATE documents SET page_count = ?, indexed = 0 WHERE id = ?').run(pageCount, id)
  return indexDocument(id, pages)
}

/**
 * Delete a knowledge-base document, its chunks, and the file on disk.
 * (Guideline PDFs are reference material, not regulated participant records.)
 * @param {number} id
 */
export function deleteDocument (id) {
  const doc = getDocument(id)
  sqlite.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id)
  sqlite.prepare('DELETE FROM documents WHERE id = ?').run(id)
  const filePath = path.join(config.uploadPath, 'documents', doc.filename)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  return doc
}
