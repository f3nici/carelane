import config from '../config.js'

/**
 * In-memory brute-force throttle for the login endpoint. Suits the
 * single-operator, self-hosted deployment (no external store needed); counters
 * reset on restart. Only failed attempts are counted — a successful login
 * clears the key.
 */

/** @type {Map<string, { count: number, firstAt: number, lockedUntil: number }>} */
const attempts = new Map()

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
 * Check whether a key is currently locked out.
 * @param {string} key
 * @returns {{ locked: boolean, retryAfter: number }} retryAfter in seconds
 */
export function checkLockout (key) {
  const rec = attempts.get(key)
  if (!rec) return { locked: false, retryAfter: 0 }
  const nowMs = Date.now()
  if (rec.lockedUntil && rec.lockedUntil > nowMs) {
    return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - nowMs) / 1000) }
  }
  // Window elapsed since the first attempt — forget the history.
  if (nowMs - rec.firstAt > windowMs()) {
    attempts.delete(key)
  }
  return { locked: false, retryAfter: 0 }
}

/**
 * Record a failed attempt, locking the key once the threshold is reached.
 * @param {string} key
 * @returns {{ locked: boolean, retryAfter: number, remaining: number }}
 */
export function recordFailure (key) {
  const nowMs = Date.now()
  const rec = attempts.get(key)
  if (!rec || nowMs - rec.firstAt > windowMs()) {
    attempts.set(key, { count: 1, firstAt: nowMs, lockedUntil: 0 })
    return { locked: false, retryAfter: 0, remaining: config.loginMaxAttempts - 1 }
  }
  rec.count += 1
  if (rec.count >= config.loginMaxAttempts) {
    rec.lockedUntil = nowMs + windowMs()
    return { locked: true, retryAfter: Math.ceil(windowMs() / 1000), remaining: 0 }
  }
  return { locked: false, retryAfter: 0, remaining: config.loginMaxAttempts - rec.count }
}

/**
 * Clear a key after a successful login.
 * @param {string} key
 */
export function clearAttempts (key) {
  attempts.delete(key)
}

/** Test helper: wipe all throttle state. */
export function resetAll () {
  attempts.clear()
}
