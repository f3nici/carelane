import { sqlite, vecAvailable } from '../db/connection.js'
import config from '../config.js'

let embedderPromise = null

/**
 * Lazily load the local embedding pipeline (transformers.js). No external
 * embedding API is ever used — zero token cost.
 */
function getEmbedder () {
  if (!embedderPromise) {
    embedderPromise = import('@xenova/transformers').then(async ({ pipeline }) =>
      pipeline('feature-extraction', config.embeddingModel))
  }
  return embedderPromise
}

/**
 * Embed a text string locally into a Float32Array (mean-pooled, normalised).
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embed (text) {
  const extractor = await getEmbedder()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  return Float32Array.from(output.data)
}

/**
 * Split page texts into ~500–800-token chunks (approximated by characters)
 * with a small overlap, preserving the source page number.
 * @param {string[]} pages text per page (index 0 = page 1)
 * @returns {Array<{page:number, content:string}>}
 */
export function chunkPages (pages) {
  const CHUNK = 2400 // ~600 tokens
  const OVERLAP = 240
  const chunks = []
  pages.forEach((pageText, i) => {
    const text = (pageText || '').replace(/\s+/g, ' ').trim()
    if (!text) return
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + CHUNK, text.length)
      if (end < text.length) {
        const breakAt = text.lastIndexOf('. ', end)
        if (breakAt > start + CHUNK / 2) end = breakAt + 1
      }
      chunks.push({ page: i + 1, content: text.slice(start, end).trim() })
      if (end >= text.length) break
      start = end - OVERLAP
    }
  })
  return chunks
}

/**
 * Index a document: chunk, embed locally, store vectors in document_chunks.
 * @param {number} documentId
 * @param {string[]} pages text per page
 * @returns {Promise<number>} chunk count
 */
export async function indexDocument (documentId, pages) {
  const chunks = chunkPages(pages)
  sqlite.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId)
  const insert = sqlite.prepare(`INSERT INTO document_chunks
    (document_id, chunk_index, page, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
  const ts = new Date().toISOString()
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(chunks[i].content)
    insert.run(documentId, i, chunks[i].page, chunks[i].content, Buffer.from(vector.buffer), ts)
  }
  sqlite.prepare('UPDATE documents SET indexed = 1 WHERE id = ?').run(documentId)
  return chunks.length
}

function cosine (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are normalised
}

/**
 * Semantic search over indexed chunks. Uses sqlite-vec distance when the
 * extension is available, otherwise JS cosine similarity. Falls back to plain
 * keyword matching when nothing is indexed.
 * @param {string} query
 * @param {number} [k]
 * @returns {Promise<Array<{document_id:number, title:string, page:number, content:string, score:number}>>}
 */
export async function searchChunks (query, k = 5) {
  const count = sqlite.prepare('SELECT COUNT(*) AS c FROM document_chunks WHERE embedding IS NOT NULL').get().c
  if (count === 0) return keywordSearch(query, k)
  const qVec = await embed(query)
  if (vecAvailable) {
    return sqlite.prepare(`SELECT dc.document_id, d.title, dc.page, dc.content,
        (1.0 - vec_distance_cosine(dc.embedding, ?)) AS score
      FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
      WHERE dc.embedding IS NOT NULL
      ORDER BY score DESC LIMIT ?`).all(Buffer.from(qVec.buffer), k)
  }
  const rows = sqlite.prepare(`SELECT dc.document_id, d.title, dc.page, dc.content, dc.embedding
    FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL`).all()
  return rows
    .map(r => ({
      document_id: r.document_id,
      title: r.title,
      page: r.page,
      content: r.content,
      score: cosine(qVec, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/**
 * Plain LIKE keyword search over chunk text (complements semantic search).
 * @param {string} query
 * @param {number} [k]
 */
export function keywordSearch (query, k = 5) {
  return sqlite.prepare(`SELECT dc.document_id, d.title, dc.page, dc.content, 0 AS score
    FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
    WHERE dc.content LIKE ? ORDER BY dc.document_id, dc.chunk_index LIMIT ?`)
    .all(`%${query}%`, k)
}
