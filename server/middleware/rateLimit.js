import { ApiError } from './errorHandler.js'
import { sqlite } from '../db/connection.js'

/**
 * DB-backed rate limiter for expensive or abusable authenticated endpoints (AI
 * drafting/Q&A, outbound integration tests, the unauthenticated passkey-options
 * probe). Keyed per user+route, it caps how many calls one operator can make in
 * a fixed window. Counters live in the shared `throttle_hits` SQLite table (not
 * process memory) so the cap survives restarts and holds across workers — same
 * store as the login brute-force throttle. This guards cost/amplification, not
 * credentials.
 *
 * @param {{ max?: number, windowMs?: number, name?: string }} [opts]
 * @returns {import('express').RequestHandler}
 */
export function rateLimit ({ max = 30, windowMs = 60 * 1000, name = 'rl' } = {}) {
  return (req, res, next) => {
    const key = `rl:${name}:${req.session?.userId ?? req.ip}`
    const { count, resetAt } = bump(key, windowMs, Date.now())
    if (count > max) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      res.set('Retry-After', String(retryAfter))
      return next(new ApiError(429, 'RATE_LIMITED', `Too many requests — wait ${retryAfter}s and try again.`))
    }
    next()
  }
}

// Atomically increment the per-key counter inside its window, resetting it once
// the window has elapsed. Runs as a single IMMEDIATE transaction so concurrent
// requests (or workers) cannot both read a stale count. `locked_until` is unused
// by the rate limiter (it shares the table with the login throttle), so it is
// left at 0; the row's window is `first_at .. first_at + windowMs`.
const bump = sqlite.transaction((key, windowMs, nowMs) => {
  const rec = sqlite.prepare('SELECT count, first_at AS firstAt FROM throttle_hits WHERE key = ?').get(key)
  if (!rec || nowMs - rec.firstAt > windowMs) {
    sqlite.prepare(`INSERT INTO throttle_hits (key, count, first_at, locked_until) VALUES (?, 1, ?, 0)
      ON CONFLICT(key) DO UPDATE SET count = 1, first_at = excluded.first_at, locked_until = 0`).run(key, nowMs)
    return { count: 1, resetAt: nowMs + windowMs }
  }
  const count = rec.count + 1
  sqlite.prepare('UPDATE throttle_hits SET count = ? WHERE key = ?').run(count, key)
  return { count, resetAt: rec.firstAt + windowMs }
})
