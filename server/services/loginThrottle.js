import config from '../config.js'
import { sqlite } from '../db/connection.js'

/**
 * DB-backed brute-force throttle for the login endpoint. Counters live in the
 * `throttle_hits` SQLite table (not process memory) so a lockout survives a
 * restart and — with a shared database file — holds across multiple workers,
 * matching the documented multi-worker future. Only failed attempts are counted;
 * a successful login clears the key.
 */

const windowMs = () => config.loginWindowMinutes * 60 * 1000

/**
 * Build the throttle key from request IP and username so that one account being
 * attacked cannot lock out logins from another client, and vice-versa.
 * @param {string} ip
 * @param {string} [username]
 * @returns {string}
 */
export function throttleKey (ip, username) {
  return `${ip || 'unknown'}:${String(username || '').toLowerCase()}`
}

/**
 * Build a username-only (IP-independent) throttle key. Used alongside the
 * ip+username key so a credential-stuffing attack spread across many source IPs
 * is still caught on the targeted account. Paired with a higher attempt
 * threshold so it does not lock the legitimate operator out on a few typos.
 * @param {string} [username]
 * @returns {string}
 */
export function globalThrottleKey (username) {
  return `user:${String(username || '').toLowerCase()}`
}

/** Read the bucket row for a key (null when absent). */
function getBucket (key) {
  return sqlite.prepare(
    'SELECT count, first_at AS firstAt, locked_until AS lockedUntil FROM throttle_hits WHERE key = ?'
  ).get(key)
}

/**
 * Check whether a key is currently locked out.
 * @param {string} key
 * @returns {{ locked: boolean, retryAfter: number }} retryAfter in seconds
 */
export function checkLockout (key) {
  const rec = getBucket(key)
  if (!rec) return { locked: false, retryAfter: 0 }
  const nowMs = Date.now()
  if (rec.lockedUntil && rec.lockedUntil > nowMs) {
    return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - nowMs) / 1000) }
  }
  // Window elapsed since the first attempt — forget the history.
  if (nowMs - rec.firstAt > windowMs()) {
    sqlite.prepare('DELETE FROM throttle_hits WHERE key = ?').run(key)
  }
  return { locked: false, retryAfter: 0 }
}

// Record a failure atomically: the read-modify-write runs inside a single
// IMMEDIATE transaction so two concurrent attempts (or two workers) can never
// both read a stale count and under-count the failures.
const recordFailureTx = sqlite.transaction((key, maxAttempts, win, nowMs) => {
  const rec = getBucket(key)
  if (!rec || nowMs - rec.firstAt > win) {
    sqlite.prepare(`INSERT INTO throttle_hits (key, count, first_at, locked_until) VALUES (?, 1, ?, 0)
      ON CONFLICT(key) DO UPDATE SET count = 1, first_at = excluded.first_at, locked_until = 0`).run(key, nowMs)
    return { locked: false, retryAfter: 0, remaining: maxAttempts - 1 }
  }
  const count = rec.count + 1
  if (count >= maxAttempts) {
    const lockedUntil = nowMs + win
    sqlite.prepare('UPDATE throttle_hits SET count = ?, locked_until = ? WHERE key = ?').run(count, lockedUntil, key)
    return { locked: true, retryAfter: Math.ceil(win / 1000), remaining: 0 }
  }
  sqlite.prepare('UPDATE throttle_hits SET count = ? WHERE key = ?').run(count, key)
  return { locked: false, retryAfter: 0, remaining: maxAttempts - count }
})

/**
 * Record a failed attempt, locking the key once the threshold is reached.
 * @param {string} key
 * @param {number} [maxAttempts] threshold override (defaults to config)
 * @returns {{ locked: boolean, retryAfter: number, remaining: number }}
 */
export function recordFailure (key, maxAttempts = config.loginMaxAttempts) {
  return recordFailureTx(key, maxAttempts, windowMs(), Date.now())
}

/**
 * Clear a key after a successful login.
 * @param {string} key
 */
export function clearAttempts (key) {
  sqlite.prepare('DELETE FROM throttle_hits WHERE key = ?').run(key)
}

/**
 * Purge throttle/rate-limit rows that are well past their window and no longer
 * locked, keeping the table from growing unbounded. Conservative threshold so
 * an in-window bucket is never dropped regardless of the (per-route) window. Run
 * opportunistically and on a timer from the server bootstrap.
 * @returns {number} rows removed
 */
export function purgeExpired () {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return sqlite.prepare('DELETE FROM throttle_hits WHERE locked_until < ? AND first_at < ?')
    .run(Date.now(), cutoff).changes
}

/** Test helper: wipe all throttle state. */
export function resetAll () {
  sqlite.prepare('DELETE FROM throttle_hits').run()
}
