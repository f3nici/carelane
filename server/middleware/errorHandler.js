import { logger } from '../services/logger.js'
// ApiError is defined in `@carelane/core` and thrown by the core services, so it
// must be the *same* class the error handler checks with `instanceof`. Re-export
// it here so every existing `../middleware/errorHandler.js` import is unchanged.
import { ApiError } from '@carelane/core'

export { ApiError }

/** 404 helper for unmatched API routes. */
export function notFound (req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Resource not found', details: [] } })
}

/**
 * Central error handler producing the standard error envelope.
 * Never leaks stack traces or PII to the client.
 */
export function errorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details }
    })
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error: { code: 'UPLOAD_ERROR', message: err.message, details: [] }
    })
  }
  logger.error('unhandled error', { name: err.name, msg: err.message, path: req.path, method: req.method })
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: [] }
  })
}
