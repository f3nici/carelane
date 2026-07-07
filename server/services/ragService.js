import { sqlite, vecAvailable } from '../db/connection.js'
import { scorePassages } from './rerankService.js'
import { escapeLike } from '../utils/sql.js'
import config from '../config.js'

let embedderPromise = null

/**
 * Lazily load the local embedding pipeline (transformers.js). No external
 * embedding API is ever used — zero token cost.
 */
function getEmbedder () {
  if (!embedderPromise) {
    embedderPromise = import('@huggingface/transformers').then(async ({ pipeline }) =>
      pipeline('feature-extraction', config.embeddingModel))
  }
  return embedderPromise
}

/**
 * Embed a passage locally into a Float32Array (mean-pooled, normalised).
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embed (text) {
  const extractor = await getEmbedder()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  return Float32Array.from(output.data)
}

/**
 * Embed a search query. bge-style models retrieve better when the query carries
 * a short instruction prefix (passages are embedded without it).
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export function embedQuery (text) {
  return embed(config.embeddingQueryPrefix + text)
}

/**
 * Split page texts into ~300-token chunks (approximated by characters) with a
 * small overlap, preserving the source page number. Smaller chunks retrieve
 * more precisely and give the reranker tighter passages to score.
 * @param {string[]} pages text per page (index 0 = page 1)
 * @returns {Array<{page:number, content:string}>}
 */
export function chunkPages (pages) {
  const CHUNK = 1200 // ~300 tokens
  const OVERLAP = 180
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
 * The FTS5 keyword index is kept in sync automatically by SQLite triggers.
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
  sqlite.prepare('UPDATE documents SET indexed = 1, embedding_model = ? WHERE id = ?')
    .run(config.embeddingModel, documentId)
  return chunks.length
}

function toFloat32 (blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

function cosine (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are normalised
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: alphanumeric terms,
 * each quoted, OR-joined for recall. Returns null when there is nothing to match.
 * @param {string} query
 * @returns {string|null}
 */
export function ftsMatchQuery (query) {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/gi) || []).filter(t => t.length > 1)
  if (!terms.length) return null
  return terms.map(t => `"${t}"`).join(' OR ')
}

/**
 * Fuse several ranked lists of chunk ids with Reciprocal Rank Fusion. RRF ranks
 * by position, so the vector and keyword arms (wildly different score scales)
 * combine without calibration; items ranked highly by either arm rise to the top.
 * @param {number[][]} lists ranked chunk-id lists (best first)
 * @param {number} [k] RRF damping constant (60 is the standard default)
 * @returns {number[]} fused chunk ids, best first
 */
export function rrfFuse (lists, k = 60) {
  const scores = new Map()
  for (const list of lists) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * Vector (semantic) first-pass: nearest chunk ids to the query embedding.
 * @param {Float32Array} qVec
 * @param {number} k
 * @returns {number[]} chunk ids, best first
 */
function vectorCandidates (qVec, k) {
  if (vecAvailable) {
    return sqlite.prepare(`SELECT id FROM document_chunks
      WHERE embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC LIMIT ?`)
      .all(Buffer.from(qVec.buffer), k).map(r => r.id)
  }
  const rows = sqlite.prepare('SELECT id, embedding FROM document_chunks WHERE embedding IS NOT NULL').all()
  return rows
    .map(r => ({ id: r.id, score: cosine(qVec, toFloat32(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(r => r.id)
}

/**
 * Keyword (BM25) first-pass over the FTS5 index.
 * @param {string} query
 * @param {number} k
 * @returns {number[]} chunk ids, best first
 */
function keywordCandidates (query, k) {
  const match = ftsMatchQuery(query)
  if (!match) return []
  try {
    return sqlite.prepare(`SELECT rowid AS id FROM document_chunks_fts
      WHERE document_chunks_fts MATCH ?
      ORDER BY bm25(document_chunks_fts) ASC LIMIT ?`).all(match, k).map(r => r.id)
  } catch {
    return [] // FTS table absent or query rejected — fall back to vector only
  }
}

/** Fetch chunk rows by id, returned in the order of the given id list. */
function fetchChunks (ids) {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = sqlite.prepare(`SELECT dc.id, dc.document_id, d.title, dc.page, dc.content, dc.embedding
    FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
    WHERE dc.id IN (${placeholders})`).all(...ids)
  const byId = new Map(rows.map(r => [r.id, r]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}

/**
 * Hybrid search over indexed chunks: vector + BM25 keyword first-passes fused
 * with RRF, then (optionally) reordered by a local cross-encoder reranker.
 * Fully local — no external API, no token cost.
 * @param {string} query
 * @param {number} [k] number of results to return
 * @returns {Promise<Array<{document_id:number, title:string, page:number, content:string, score:number}>>}
 */
export async function searchChunks (query, k = 5) {
  const count = sqlite.prepare('SELECT COUNT(*) AS c FROM document_chunks WHERE embedding IS NOT NULL').get().c
  if (count === 0) return keywordSearch(query, k)

  const pool = Math.max(config.searchCandidatePool, k)
  const qVec = await embedQuery(query)
  const fusedIds = rrfFuse([vectorCandidates(qVec, pool), keywordCandidates(query, pool)]).slice(0, pool)
  const rows = fetchChunks(fusedIds)
  if (!rows.length) return []

  let ordered = rows
  let rerankScores = null
  if (config.rerankEnabled) {
    try {
      const scores = await scorePassages(query, rows.map(r => r.content))
      const withScore = rows.map((r, i) => ({ row: r, score: scores[i] }))
      withScore.sort((a, b) => b.score - a.score)
      ordered = withScore.map(w => w.row)
      rerankScores = new Map(withScore.map(w => [w.row.id, 1 / (1 + Math.exp(-w.score))]))
    } catch (err) {
      console.warn('reranker unavailable, using fused order:', err.message)
    }
  }

  return ordered.slice(0, k).map(r => ({
    document_id: r.document_id,
    title: r.title,
    page: r.page,
    content: r.content,
    score: rerankScores ? rerankScores.get(r.id) : cosine(qVec, toFloat32(r.embedding))
  }))
}

/**
 * Keyword-only search over the FTS5 (BM25) index — used for the explicit
 * "keyword" search mode and as a fallback before anything is embedded.
 * @param {string} query
 * @param {number} [k]
 */
export function keywordSearch (query, k = 5) {
  const ids = keywordCandidates(query, k)
  if (ids.length) {
    return fetchChunks(ids).map(r => ({
      document_id: r.document_id, title: r.title, page: r.page, content: r.content, score: 0
    }))
  }
  // Last-resort substring match (e.g. before the FTS index is populated).
  return sqlite.prepare(`SELECT dc.document_id, d.title, dc.page, dc.content, 0 AS score
    FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
    WHERE dc.content LIKE ? ESCAPE '\\' ORDER BY dc.document_id, dc.chunk_index LIMIT ?`)
    .all(`%${escapeLike(query)}%`, k)
}

/**
 * Warn (don't block) when any indexed document was embedded with a different
 * model than the one now configured. Embeddings from different models are not
 * comparable, so those documents need re-indexing — via `npm run reindex` or the
 * per-document re-index button. Tracked per document, so the warning clears
 * itself as each stale document is re-indexed. Mirrors the spirit of the
 * encryption canary: surface drift loudly rather than return poor results.
 */
export function checkEmbeddingModel () {
  const stale = sqlite.prepare(`SELECT COUNT(*) AS c FROM documents
    WHERE indexed = 1 AND (embedding_model IS NULL OR embedding_model <> ?)`).get(config.embeddingModel).c
  if (stale > 0) {
    console.warn(`${stale} knowledge-base document(s) were embedded with a different model than ` +
      `${config.embeddingModel}. Run "npm run reindex" (or re-index them in the UI) to refresh.`)
  }
}
