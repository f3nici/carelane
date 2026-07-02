// settingsService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./settingsService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  getSettings,
  getSetting,
  updateSettings
} = services.settings
