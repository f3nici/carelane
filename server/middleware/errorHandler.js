import { logger } from '../services/logger.js'

/**
 * Application error with an API error code and HTTP status.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code machine-readable error code
   * @param {string} message human-readable message
   * @param {Array} [details]
   */
  constructor (status, code, message, details = []) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

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
