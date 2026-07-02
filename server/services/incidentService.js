// incidentService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./incidentService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listIncidents,
  getIncident,
  createIncident,
  createFromShift,
  updateIncident,
  deleteIncident,
  restoreIncident,
  countOpenIncidents,
  countUnreportedReportable,
  listOpenIncidents,
  buildIncidentMarkdown,
  incidentTypeLabel
} = services.incident
