/**
 * `@carelane/core` — CareLane's portable domain logic.
 *
 * Runs unmodified in Node (the Express server) and React Native (the app). All
 * persistence and crypto are injected via a context object, so the package has
 * zero imports of `better-sqlite3`, `node:crypto`, or any server-only module.
 *
 * @typedef {object} CoreContext
 * @property {any} [db] a Drizzle instance (drizzle-orm/better-sqlite3 on the
 *   server, drizzle-orm/op-sqlite in the app). Reserved for future query-builder
 *   use; today the services talk to the raw `sqlite` query interface below.
 * @property {any} sqlite a synchronous SQLite query interface exposing
 *   `prepare(sql)` → `{ get, all, run }`, plus `transaction(fn)` and `exec(sql)`
 *   (better-sqlite3 on the server; an op-sqlite-backed shim in the app).
 * @property {import('./services/cryptoService.js').CryptoProvider} crypto
 *   node:crypto-compatible primitives (`node:crypto` on the server,
 *   `react-native-quick-crypto` in the app).
 * @property {string} encryptionSecret the shared PII/blind-index secret.
 * @property {() => number} [now] injectable clock (epoch ms); defaults to `Date.now`.
 */

export { createServices } from './createServices.js'
export { createCryptoService } from './services/cryptoService.js'
export { createActivityService, diffChanges } from './services/activityService.js'
export { createSettingsService } from './services/settingsService.js'
export { createAccountService } from './services/accountService.js'
export { createBillingService } from './services/billingService.js'
export { createTemplateService } from './services/templateService.js'
export { createClientService } from './services/clientService.js'
export { createAgreementService } from './services/agreementService.js'
export { createShiftService } from './services/shiftService.js'
export { createGoalService } from './services/goalService.js'
export { createMedicationService } from './services/medicationService.js'
export { createRestrictivePracticeService } from './services/restrictivePracticeService.js'
export { createReportService } from './services/reportService.js'
export { createClientDocumentService } from './services/clientDocumentService.js'
export { createIncidentService } from './services/incidentService.js'
export { createRecurrenceService } from './services/recurrenceService.js'
export { createScheduleService } from './services/scheduleService.js'
export { createDeletedService } from './services/deletedService.js'
export { ApiError } from './errors.js'
export { escapeLike } from './utils/sql.js'
export * from './validators.js'
export * as schema from './schema.js'
