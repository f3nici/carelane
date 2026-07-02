// restrictivePracticeService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./restrictivePracticeService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listRestrictivePractices,
  getRestrictivePractice,
  createRestrictivePractice,
  updateRestrictivePractice,
  deleteRestrictivePractice,
  restoreRestrictivePractice
} = services.restrictivePractice
