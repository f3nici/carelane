import config from '../config.js'

let rerankerPromise = null

/**
 * Lazily load the local cross-encoder reranker (transformers.js). No external
 * API is used — zero token cost. The model is downloaded/cached on first use.
 */
function getReranker () {
  if (!rerankerPromise) {
    rerankerPromise = import('@xenova/transformers').then(async ({ AutoTokenizer, AutoModelForSequenceClassification }) => {
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(config.rerankerModel),
        AutoModelForSequenceClassification.from_pretrained(config.rerankerModel)
      ])
      return { tokenizer, model }
    })
  }
  return rerankerPromise
}

/**
 * Score query/passage relevance with the cross-encoder. Returns one raw logit
 * per passage (higher = more relevant), aligned with the input order. A
 * cross-encoder reads the query and passage together, so it judges relevance far
 * more precisely than the bi-encoder used for first-pass retrieval.
 * @param {string} query
 * @param {string[]} passages
 * @returns {Promise<number[]>}
 */
export async function scorePassages (query, passages) {
  if (!passages.length) return []
  const { tokenizer, model } = await getReranker()
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true
  })
  const { logits } = await model(inputs)
  return Array.from(logits.data)
}
