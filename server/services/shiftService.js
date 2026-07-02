// shiftService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./shiftService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listShifts,
  getShift,
  createShift,
  updateShift,
  deleteShift,
  archiveShift,
  unarchiveShift,
  restoreShift,
  addPhoto,
  getPhoto,
  deletePhoto
} = services.shift
