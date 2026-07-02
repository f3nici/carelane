// scheduleService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./scheduleService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listScheduled,
  getScheduled,
  createScheduled,
  updateScheduled,
  clockIn,
  clockOut,
  notePrefill,
  createNoteFromShift,
  cancelScheduled,
  deleteScheduled,
  restoreScheduled,
  upcomingScheduled,
  activeShift
} = services.schedule
