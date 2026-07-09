// PII-at-rest encryption now lives in `@carelane/core` (host-agnostic, with
// `node:crypto` injected as the CryptoProvider — see server/services/_core.js).
// Re-exported here as bound functions so existing imports of
// `./cryptoService.js` (services, routes, tests) keep working unchanged.
import { services } from './_core.js'

export const {
  encrypt,
  decrypt,
  blindIndex,
  encryptFields,
  decryptFields,
  assertEncryptionCanary,
  encryptionSecretMatches
} = services.crypto
