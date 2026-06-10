import { sqlite } from '../db/connection.js'

/** Settings keys that must never be exposed or written via the API. */
const PROTECTED_KEYS = new Set(['enc_canary'])

/**
 * Read all settings as a plain object (JSON-decoded values).
 */
export function getSettings () {
  const rows = sqlite.prepare('SELECT key, value FROM settings').all()
  const out = {}
  for (const r of rows) {
    if (PROTECTED_KEYS.has(r.key)) continue
    try { out[r.key] = JSON.parse(r.value) } catch { out[r.key] = r.value }
  }
  return out
}

/**
 * Read a single setting value.
 * @param {string} key
 * @param {*} [fallback]
 */
export function getSetting (key, fallback = null) {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return row.value }
}

/**
 * Upsert multiple settings.
 * @param {object} patch key/value map
 */
export function updateSettings (patch) {
  const stmt = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = sqlite.transaction(entries => {
    for (const [key, value] of entries) {
      if (PROTECTED_KEYS.has(key)) continue
      stmt.run(key, JSON.stringify(value))
    }
  })
  tx(Object.entries(patch))
  return getSettings()
}
