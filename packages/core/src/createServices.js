import { createCryptoService } from './services/cryptoService.js'
import { createActivityService } from './services/activityService.js'
import { createSettingsService } from './services/settingsService.js'
import { createAccountService } from './services/accountService.js'
import { createBillingService } from './services/billingService.js'
import { createTemplateService } from './services/templateService.js'
import { createClientService } from './services/clientService.js'
import { createAgreementService } from './services/agreementService.js'
import { createShiftService } from './services/shiftService.js'
import { createGoalService } from './services/goalService.js'
import { createMedicationService } from './services/medicationService.js'
import { createRestrictivePracticeService } from './services/restrictivePracticeService.js'
import { createReportService } from './services/reportService.js'
import { createClientDocumentService } from './services/clientDocumentService.js'
import { createIncidentService } from './services/incidentService.js'
import { createRecurrenceService } from './services/recurrenceService.js'
import { createScheduleService } from './services/scheduleService.js'
import { createDeletedService } from './services/deletedService.js'

/**
 * Assemble the portable CareLane domain services against a host-supplied
 * context. Both hosts (the Node server with `better-sqlite3` + `node:crypto`,
 * and the React Native app with `op-sqlite` + `react-native-quick-crypto`) build
 * this context and call `createServices` once at startup.
 *
 * Services are wired in dependency order and reference each other through the
 * returned `services` object, so no service imports another host module or a
 * global singleton.
 *
 * @param {import('./index.js').CoreContext} ctx
 * @returns {object} the assembled services keyed by short name (crypto, client, …)
 */
export function createServices (ctx) {
  const c = { now: () => Date.now(), ...ctx }
  const services = {}
  services.crypto = createCryptoService(c)
  services.activity = createActivityService(c)
  services.settings = createSettingsService(c)
  services.account = createAccountService(c)
  services.billing = createBillingService(c)
  services.template = createTemplateService(c)
  services.client = createClientService(c, services)
  services.agreement = createAgreementService(c, services)
  services.shift = createShiftService(c, services)
  services.goal = createGoalService(c, services)
  services.medication = createMedicationService(c, services)
  services.restrictivePractice = createRestrictivePracticeService(c, services)
  services.report = createReportService(c, services)
  services.clientDocument = createClientDocumentService(c, services)
  services.incident = createIncidentService(c, services)
  services.recurrence = createRecurrenceService(c, services)
  services.schedule = createScheduleService(c, services)
  services.deleted = createDeletedService(c, services)
  return services
}
