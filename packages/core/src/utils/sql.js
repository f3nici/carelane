/**
 * Escape a user-supplied string for safe use inside a SQL `LIKE` pattern.
 * Without this, `%` and `_` from the user act as wildcards (unexpected matches)
 * and a `%`-heavy term forces a full-table scan. The value is still passed as a
 * bound parameter — this only neutralises the wildcard metacharacters. Pair it
 * with an `ESCAPE '\'` clause on the query.
 * @param {string} value
 * @returns {string}
 */
export function escapeLike (value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`)
}

/**
 * Constrain a list query to a set of participant (client) ids for access
 * control. When `clientIds` is not an array the query is left unrestricted
 * (an admin sees everything). An empty array means "assigned to nothing", so a
 * `0` predicate is pushed to return no rows rather than accidentally matching
 * all of them. Mutates `where`/`params` in place; pair with the caller's own
 * `WHERE ... AND` join.
 * @param {string[]} where accumulating predicate list
 * @param {any[]} params accumulating bound-parameter list
 * @param {string} column the (possibly aliased) client-id column, e.g. `s.client_id`
 * @param {number[]|null|undefined} clientIds allowed ids, or null/undefined for unrestricted
 */
export function applyClientScope (where, params, column, clientIds) {
  if (!Array.isArray(clientIds)) return
  if (!clientIds.length) { where.push('0'); return }
  where.push(`${column} IN (${clientIds.map(() => '?').join(', ')})`)
  params.push(...clientIds)
}
