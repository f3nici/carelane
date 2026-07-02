// The append-only, tamper-evident audit hash-chain now lives in
// `@carelane/core` (both hosts need it). Re-exported here as bound functions so
// existing imports of `./activityService.js` (routes, migrate, tests) keep
// working unchanged.
import { services } from './_core.js'

export const {
  diffChanges,
  computeEntryHash,
  logActivity,
  backfillAuditHashes,
  verifyAuditChain,
  recentActivity,
  queryActivity,
  activityFacets
} = services.activity
