import { sqlite } from '../db/connection.js'
import { ApiError } from '../middleware/errorHandler.js'
import config from '../config.js'

/**
 * Active login sessions ("devices") for the current operator, backed by the
 * better-sqlite3-session-store `sessions` table (columns: sid, sess JSON,
 * expire). Each authenticated request stamps lightweight device metadata
 * (created/last-seen, IP, truncated user-agent) onto the session via
 * {@link stampDevice}/{@link touchSession}, which this service surfaces so the
 * operator can review where they're signed in and revoke a session remotely.
 *
 * Only the owner's own sessions are ever listed or revocable; the stored `sid`
 * is meaningless without the SESSION_SECRET that signs the cookie, so returning
 * it to its owner as a revoke handle is safe.
 */

// Re-stamp last-seen at most this often to avoid writing the session on every
// single request (express-session would persist the row each time).
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

const now = () => new Date().toISOString()

/** Trim a user-agent string to something loggable without bloating the row. */
function shortUa (ua) {
  return ua ? String(ua).slice(0, 200) : null
}

/**
 * Record device metadata on a freshly-established session (called at login,
 * after `regenerate`). Safe no-op when there is no session.
 * @param {import('express').Request} req
 */
export function stampDevice (req) {
  if (!req.session) return
  const ts = now()
  req.session.createdAt = ts
  req.session.lastSeenAt = ts
  req.session.ip = req.ip
  req.session.ua = shortUa(req.get('user-agent'))
}

/**
 * Express middleware: refresh the session's last-seen timestamp (and fill in
 * device metadata for sessions that predate this feature) at most every
 * TOUCH_INTERVAL_MS. Mounted after the session + auth stack.
 */
export function touchSession (req, res, next) {
  const s = req.session
  if (s?.userId) {
    const last = s.lastSeenAt ? Date.parse(s.lastSeenAt) : 0
    if (Date.now() - last > TOUCH_INTERVAL_MS) {
      s.lastSeenAt = now()
      if (!s.createdAt) s.createdAt = s.lastSeenAt
      if (s.ip == null) s.ip = req.ip
      if (s.ua == null) s.ua = shortUa(req.get('user-agent'))
    }
  }
  next()
}

/** Parse a stored session row, swallowing malformed JSON. */
function parseRow (row) {
  try { return { sid: row.sid, sess: JSON.parse(row.sess), expire: row.expire } } catch { return null }
}

/**
 * List the current user's active (unexpired) sessions, most-recent first, with
 * the caller's own session flagged.
 * @param {number} userId
 * @param {string} currentSid the requesting session's id
 * @returns {Array<{ sid:string, current:boolean, created_at:string, last_seen_at:string, ip:string, user_agent:string, expires:string }>}
 */
export function listUserSessions (userId, currentSid) {
  let rows
  try {
    rows = sqlite.prepare("SELECT sid, sess, expire FROM sessions WHERE datetime('now') < datetime(expire)").all()
  } catch {
    return [] // sessions table not created yet (no request has hit the store)
  }
  return rows
    .map(parseRow)
    .filter(r => r && r.sess.userId === userId)
    .map(r => ({
      sid: r.sid,
      current: r.sid === currentSid,
      created_at: r.sess.createdAt || null,
      last_seen_at: r.sess.lastSeenAt || null,
      // In the public demo the login is shared, so every visitor's session hangs
      // off the same user — never expose one visitor's IP to another. Redacted on
      // read so it still leaves the raw value in the store for the real operator.
      ip: config.demoMode ? null : (r.sess.ip || null),
      user_agent: r.sess.ua || null,
      expires: r.expire
    }))
    .sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''))
}

/**
 * Revoke (delete) one of the current user's sessions by id. Verifies ownership
 * first so a session id cannot be used to revoke another account's session.
 * @param {number} userId
 * @param {string} sid
 * @returns {boolean} true if a session was removed
 */
export function revokeSession (userId, sid) {
  const row = sqlite.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Session not found')
  const parsed = parseRow({ sid, sess: row.sess })
  if (!parsed || parsed.sess.userId !== userId) {
    // Don't reveal that the sid exists but belongs to someone else.
    throw new ApiError(404, 'NOT_FOUND', 'Session not found')
  }
  return sqlite.prepare('DELETE FROM sessions WHERE sid = ?').run(sid).changes > 0
}
