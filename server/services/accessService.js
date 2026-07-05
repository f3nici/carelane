import { sqlite } from '../db/connection.js'

/**
 * Access-control service for multi-user CareLane. Decides which participants a
 * user may reach and manages the `client_assignments` grant table. This is a
 * server-only concern (it depends on the login/role model, not the portable
 * domain), so it lives here rather than in `@carelane/core`.
 *
 * The model is deliberately simple: an `admin` sees and edits everything; a
 * `worker` sees only the participants explicitly assigned to them and only their
 * own roster, and never edits/finalises/deletes regulated records.
 */

const now = () => new Date().toISOString()

/**
 * The participant ids a worker is assigned to.
 * @param {number} userId
 * @returns {number[]}
 */
export function listAssignedClientIds (userId) {
  return sqlite.prepare('SELECT client_id FROM client_assignments WHERE user_id = ? ORDER BY client_id').all(userId).map(r => r.client_id)
}

/**
 * Whether a user may access a given participant. Admins always can; workers only
 * when the participant is assigned to them.
 * @param {{role:string, id:number}} user user row (needs role + id)
 * @param {number} clientId
 * @returns {boolean}
 */
export function canAccessClient (user, clientId) {
  if (!user) return false
  if (user.role === 'admin') return true
  const row = sqlite.prepare('SELECT 1 FROM client_assignments WHERE user_id = ? AND client_id = ?').get(user.id, clientId)
  return !!row
}

/**
 * The worker (user) rows assigned to a participant, for the admin assignment UI.
 * @param {number} clientId
 * @returns {Array<{id:number, username:string, display_name:string, role:string, active:number}>}
 */
export function listClientWorkers (clientId) {
  return sqlite.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active
    FROM client_assignments a JOIN users u ON u.id = a.user_id
    WHERE a.client_id = ? ORDER BY u.display_name, u.username`).all(clientId)
}

/**
 * Replace the full set of participants a worker is assigned to. Ignores ids for
 * participants that do not exist / are soft-deleted so a stale UI selection can't
 * create dangling grants. Runs in a transaction so the swap is atomic.
 * @param {number} userId the worker
 * @param {number[]} clientIds
 * @param {number} actingUserId admin performing the change (audit column)
 */
export function setWorkerClients (userId, clientIds, actingUserId) {
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM client_assignments WHERE user_id = ?').run(userId)
    const insert = sqlite.prepare(`INSERT OR IGNORE INTO client_assignments (user_id, client_id, created_at, created_by)
      SELECT ?, id, ?, ? FROM clients WHERE id = ? AND deleted_at IS NULL`)
    for (const cid of [...new Set(clientIds)]) insert.run(userId, now(), actingUserId, cid)
  })
  tx()
  return listAssignedClientIds(userId)
}

/**
 * Replace the full set of workers assigned to a participant (client-centric view).
 * Only non-admin, active users are grantable — admins already see everything, so
 * assigning one is a no-op that would only clutter the list.
 * @param {number} clientId
 * @param {number[]} userIds
 * @param {number} actingUserId
 */
export function setClientWorkers (clientId, userIds, actingUserId) {
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM client_assignments WHERE client_id = ?').run(clientId)
    const insert = sqlite.prepare(`INSERT OR IGNORE INTO client_assignments (user_id, client_id, created_at, created_by)
      SELECT id, ?, ?, ? FROM users WHERE id = ? AND role = 'worker'`)
    for (const uid of [...new Set(userIds)]) insert.run(clientId, now(), actingUserId, uid)
  })
  tx()
  return listClientWorkers(clientId)
}
