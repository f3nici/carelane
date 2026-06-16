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
