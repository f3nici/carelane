import { ApiError } from './errorHandler.js'

/**
 * Zod validation middleware factory. Parses `req.body` (or query) against the
 * schema and replaces it with the parsed value.
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'} [source]
 */
export function validate (schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      const details = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', details))
    }
    if (source === 'body') req.body = result.data
    else req.validatedQuery = result.data
    next()
  }
}

/**
 * Partial-update validation. Parses against `schema.partial()` but keeps only
 * the keys the caller actually sent — Zod still applies `.default()` values
 * for absent keys, which would otherwise silently reset flags like
 * `finalised`/`status` on unrelated updates.
 * @param {import('zod').ZodObject} schema
 */
export function validatePartial (schema) {
  return (req, res, next) => {
    const provided = new Set(Object.keys(req.body || {}))
    const result = schema.partial().safeParse(req.body)
    if (!result.success) {
      const details = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', details))
    }
    req.body = Object.fromEntries(Object.entries(result.data).filter(([k]) => provided.has(k)))
    next()
  }
}
