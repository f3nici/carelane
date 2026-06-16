/**
 * Map over items running at most `limit` async operations concurrently, while
 * preserving input order in the result. Used to fan out independent API calls
 * (e.g. condensing many shift notes for a report) without firing them all at
 * once or running them one-at-a-time.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit max concurrent operations
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker () {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
  return results
}
