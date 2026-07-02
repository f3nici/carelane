// agreementService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./agreementService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  agreementDueDate,
  listAgreements,
  getAgreement,
  createAgreement,
  updateAgreement,
  signAgreement,
  setAgreementPdf,
  deleteAgreement,
  archiveAgreement,
  unarchiveAgreement,
  restoreAgreement
} = services.agreement
