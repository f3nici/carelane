// recurrenceService now lives in `@carelane/core`. Re-exported here as bound
// functions so existing imports keep working. Only the node-cron nightly
// wrapper stays server-side.
import cron from 'node-cron'
import { services } from './_core.js'

export const {
  occurrenceDates,
  materialiseDueOccurrences,
  listRecurrences,
  getRecurrence,
  createRecurrence,
  updateRecurrence,
  deleteRecurrence
} = services.recurrence

/**
 * Materialise occurrences now, then every night at 00:30 local time, so the
 * rolling horizon stays populated. Safe to call once at boot. Server-only (the
 * app schedules its own materialisation), so it wraps the portable core logic
 * with node-cron here rather than in `@carelane/core`.
 */
export function scheduleMaterialisation () {
  try { materialiseDueOccurrences() } catch (err) { console.error('occurrence materialisation failed:', err) }
  cron.schedule('30 0 * * *', () => {
    try { materialiseDueOccurrences() } catch (err) { console.error('nightly occurrence materialisation failed:', err) }
  })
}
