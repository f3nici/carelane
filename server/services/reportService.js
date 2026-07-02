// reportService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./reportService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listReports,
  getReport,
  createReport,
  updateReport,
  setReportPdf,
  deleteReport,
  archiveReport,
  unarchiveReport,
  restoreReport
} = services.report
