// billingService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./billingService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listBillingCodes,
  getBillingCode,
  createBillingCode,
  updateBillingCode,
  deactivateBillingCode,
  reactivateBillingCode,
  commitImport
} = services.billing
