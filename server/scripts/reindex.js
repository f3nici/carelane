import { migrate } from '../db/migrate.js'
import { sqlite } from '../db/connection.js'
import { reindexDocument } from '../services/documentService.js'
import config from '../config.js'

/**
 * Re-embed every knowledge-base document with the currently configured
 * embedding model. Required after changing EMBEDDING_MODEL, since embeddings
 * from different models are not comparable. The FTS5 keyword index is rebuilt
 * automatically by triggers as chunks are rewritten.
 */
async function run () {
  migrate()
  const docs = sqlite.prepare('SELECT id, title FROM documents').all()
  console.log(`Re-indexing ${docs.length} document(s) with ${config.embeddingModel}…`)
  let ok = 0
  for (const doc of docs) {
    process.stdout.write(`  • ${doc.title} … `)
    try {
      const chunks = await reindexDocument(doc.id)
      console.log(`${chunks} chunks`)
      ok++
    } catch (err) {
      console.log(`FAILED: ${err.message}`)
    }
  }
  sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('embedding_model', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(config.embeddingModel)
  console.log(`Done — ${ok}/${docs.length} document(s) re-indexed.`)
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
