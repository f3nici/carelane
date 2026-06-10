/**
 * Parse pagination params from a query string.
 * @param {object} query express req.query
 * @returns {{ page: number, perPage: number, offset: number }}
 */
export function parsePagination (query) {
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1)
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page || '20', 10) || 20))
  return { page, perPage, offset: (page - 1) * perPage }
}

/**
 * Build the standard meta block.
 * @param {number} page
 * @param {number} perPage
 * @param {number} total
 */
export function paginationMeta (page, perPage, total) {
  return { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) || 0 }
}

/**
 * Standard success envelope.
 * @param {*} data
 * @param {object} [meta]
 */
export function ok (data, meta) {
  return meta ? { success: true, data, meta } : { success: true, data }
}
