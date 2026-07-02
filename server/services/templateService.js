// templateService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./templateService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  restoreTemplate,
  resolveTemplateForDraft
} = services.template
