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
