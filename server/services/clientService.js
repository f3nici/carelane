// Participant (client) domain logic now lives in `@carelane/core`. Re-exported
// here as bound functions so existing imports of `./clientService.js` (routes,
// other services, tests) keep working unchanged.
import { services } from './_core.js'

export const {
  clientDisplayName,
  getClient,
  listClients,
  listBirthdays,
  createClient,
  updateClient,
  deleteClient,
  restoreClient,
  exportClient,
  buildClientExportMarkdown,
  getClientBillingCodes,
  setClientBillingCodes
} = services.client
