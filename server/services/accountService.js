// accountService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./accountService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  changePassword,
  destroyOtherSessions,
  setPasswordByUsername
} = services.account
