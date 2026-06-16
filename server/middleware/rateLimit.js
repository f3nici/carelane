import { ApiError } from './errorHandler.js'

/**
 * Lightweight in-memory rate limiter for expensive or abusable authenticated
 * endpoints (AI drafting/Q&A, outbound integration tests). Keyed per
 * user+route, it caps how many calls one operator can make in a sliding window.
 * Suits the single-operator, self-hosted deployment — no external store, and
 * counters reset on restart. Not a substitute for the login brute-force
 * throttle; this guards cost/amplification, not credentials.
 *
 * @param {{ max?: number, windowMs?: number, name?: string }} [opts]
 * @returns {import('express').RequestHandler}
 */
export function rateLimit ({ max = 30, windowMs = 60 * 1000, name = 'rl' } = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map()
  return (req, res, next) => {
    const key = `${name}:${req.session?.userId ?? req.ip}`
    const nowMs = Date.now()
    let rec = hits.get(key)
    if (!rec || nowMs > rec.resetAt) {
      rec = { count: 0, resetAt: nowMs + windowMs }
      hits.set(key, rec)
    }
    rec.count += 1
    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.resetAt - nowMs) / 1000)
      res.set('Retry-After', String(retryAfter))
      return next(new ApiError(429, 'RATE_LIMITED', `Too many requests — wait ${retryAfter}s and try again.`))
    }
    next()
  }
}
