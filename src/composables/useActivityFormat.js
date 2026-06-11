/**
 * Helpers for rendering audit-log / activity entries consistently across the
 * dashboard feed and the full audit page. The backend stores `details` as a
 * PII-redacted JSON string, optionally carrying a field-level `changes` array.
 */

/** Tailwind text colour per action, for badges. */
export const actionColors = {
  created: 'text-success',
  created_manual: 'text-success',
  updated: 'text-info',
  status_changed: 'text-warning',
  ai_drafted: 'text-accent',
  finalised: 'text-success',
  reopened: 'text-warning',
  restored: 'text-success',
  deleted: 'text-danger',
  exported: 'text-accent',
  login: 'text-mid',
  login_failed: 'text-danger',
  '2fa_enabled': 'text-success',
  '2fa_disabled': 'text-warning',
  stale_warning: 'text-warning',
  failed: 'text-danger'
}

/**
 * Provide the activity formatting helpers.
 */
export function useActivityFormat () {
  /**
   * Safely parse a stored details JSON string into an object.
   * @param {string|object|null} details
   * @returns {object}
   */
  function parseDetails (details) {
    if (!details) return {}
    if (typeof details === 'object') return details
    try { return JSON.parse(details) || {} } catch { return {} }
  }

  /**
   * Turn a snake_case field name into a readable label ("plan_end" → "Plan end").
   * @param {string} field
   */
  function humanizeField (field) {
    return String(field || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
  }

  /**
   * Format a single before/after value for display, mapping redaction markers
   * and empties to friendly symbols.
   * @param {*} v
   */
  function formatValue (v) {
    if (v === null || v === undefined || v === '') return '—'
    if (v === '[redacted]') return '•••'
    if (v === '[truncated]') return '(long text)'
    if (v === '[updated]') return '(updated)'
    if (v === true) return 'Yes'
    if (v === false) return 'No'
    return String(v)
  }

  /**
   * Extract the field-level change list from a details object.
   * @param {object} details
   * @returns {Array<{field:string, from:*, to:*}>}
   */
  function changesOf (details) {
    return Array.isArray(details?.changes) ? details.changes : []
  }

  /**
   * Render the non-`changes` keys of a details object as a compact string.
   * @param {object} details
   */
  function extraDetails (details) {
    const entries = Object.entries(details || {}).filter(([k, v]) => k !== 'changes' && v !== null && v !== undefined && v !== false)
    return entries.map(([k, v]) => `${humanizeField(k)}: ${formatValue(v)}`).join(' · ')
  }

  return { parseDetails, humanizeField, formatValue, changesOf, extraDetails, actionColors }
}
