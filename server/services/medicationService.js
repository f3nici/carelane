// medicationService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./medicationService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listMedicationRecords,
  getMedicationRecord,
  createMedicationRecord,
  updateMedicationRecord,
  deleteMedicationRecord,
  restoreMedicationRecord
} = services.medication
