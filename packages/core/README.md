# @carelane/core

CareLane's **portable domain logic** — the business rules, validation, encryption
and audit hash-chain that must behave identically on the Express server and in the
(separate) React Native app. It runs unmodified in **both** Node and React Native
because every host-specific capability (SQLite, crypto, the clock) is **injected**,
not imported.

This package has **zero imports** of `better-sqlite3`, `node:crypto`, or any
server-only module. The published entry point is plain ESM JavaScript (Metro can
consume it without extra transpilation) plus `.d.ts` type declarations.

## Consuming it

```js
import { createServices } from '@carelane/core'

const services = createServices(ctx) // ctx described below
services.client.createClient({ first_name: 'Ada', last_name: 'Citizen', active: 1 })
services.activity.verifyAuditChain()
```

Each service is namespaced on the returned object: `services.client`,
`services.shift`, `services.crypto`, `services.activity`, … Services reference
each other through this object, so there is no global singleton and multiple
independent contexts can coexist.

- **Runtime**: `src/index.js` (plain ESM, no build step needed — the server and
  the app can both import the source directly).
- **Build** (`npm run build`, or `npm run build:core` from the repo root): emits
  `dist/` (compiled JS + `.d.ts`) via `tsc` for external/typed consumers.

## The context object (`CoreContext`)

`createServices(ctx)` takes a single object. Both hosts build it once at startup:

| Field | Server value | App value | Purpose |
|---|---|---|---|
| `sqlite` | `better-sqlite3` connection | `op-sqlite`-backed shim | Synchronous query interface: `prepare(sql)` → `{ get, all, run }`, plus `transaction(fn)` and `exec(sql)`. This is what the services actually use today (raw SQL, incl. the FTS triggers and the audit chain). |
| `db` | `drizzle(sqlite)` (`drizzle-orm/better-sqlite3`) | `drizzle-orm/op-sqlite` | A Drizzle instance. Passed through for schema alignment and future query-builder use; the current services talk to `sqlite` directly. |
| `crypto` | `node:crypto` | `react-native-quick-crypto` | The `CryptoProvider` (below). Both expose the same node-compatible API. |
| `encryptionSecret` | `ENCRYPTION_SECRET` env | provisioned at pairing | The shared PII/blind-index secret. |
| `now` | `() => Date.now()` (default) | `() => Date.now()` | Injectable clock (epoch ms) for testable, deterministic timestamps. Optional; defaults to `Date.now`. |

The server builds this in `server/services/_core.js`; the app will build the
equivalent with `op-sqlite` + `react-native-quick-crypto`.

## The `CryptoProvider` interface

`cryptoService` never imports `node:crypto`. It derives keys and implements the
exact CareLane wire format on top of a small provider of node-compatible
primitives (`node:crypto` satisfies it directly; so does
`react-native-quick-crypto`):

```js
CryptoProvider {
  scryptSync(secret, salt, keylen) -> Buffer     // scrypt key derivation
  randomBytes(size) -> Buffer                     // per-record random IV
  createCipheriv('aes-256-gcm', key, iv)          // AES-256-GCM encrypt
  createDecipheriv('aes-256-gcm', key, iv)        // AES-256-GCM decrypt
  createHmac('sha256', key)                       // HMAC blind index
  createHash('sha256')                            // audit hash chain
}
```

The wire format is preserved exactly so ciphertext stays portable between hosts
that share the secret: `enc:<iv b64>:<tag b64>:<ciphertext b64>`, a per-record
random 12-byte IV, and the fixed salts `carelane-pii-v1` (encryption) and
`carelane-blind-index-v1` (blind index).

## What is in-core vs server-only

**In `@carelane/core`** (portable — both hosts):

`cryptoService`, `activityService` (audit hash-chain), `settingsService`,
`accountService` (bcrypt via `bcryptjs`), `billingService`, `templateService`,
`clientService`, `agreementService`, `shiftService`, `goalService`,
`medicationService`, `restrictivePracticeService`, `reportService`,
`clientDocumentService` (metadata only), `incidentService` (CRUD + lifecycle +
markdown body), `recurrenceService` (occurrence expansion + materialisation),
`scheduleService`, `deletedService` — plus the Drizzle `schema`, the Zod
`validators`, `ApiError` and the `escapeLike` SQL helper.

**Server-only** (stay in `server/`, depend on Node/backend packages):

- `aiService` (`@anthropic-ai/sdk`), `ragService` + `rerankService`
  (`@xenova/transformers`, `sqlite-vec`), `documentService` (`pdf-parse`,
  `mammoth`), `backupService` (`archiver`, fs), `squareService`,
  `googleCalendarService`, `ntfyService`, `metrics`, `swagger`.
- **PDF rendering** (`pdfkit`) for incident/report exports — `incidentService`'s
  record logic is in-core, but the `export.pdf` rendering stays server-side.
- **Auth/session machinery**: `securityPolicyService`, `sessionService`,
  `passkeyService`, login throttling, rate limiting, CSRF. The app implements its
  own local device auth and does not reuse these.

### Optional integration hooks

`scheduleService` and `recurrenceService` mirror shift changes to Google Calendar,
which is a **server-only** integration. They read it lazily from
`ctx.googleCalendar` (`{ syncScheduledShift, removeScheduledShift }`); the server's
`googleCalendarService` registers itself there when it loads. Hosts that don't wire
it (the app) leave `ctx.googleCalendar` unset and the mirror calls are no-ops.

`recurrenceService.scheduleMaterialisation` (the nightly `node-cron` wrapper) also
stays server-side; the portable `materialiseDueOccurrences` it calls is in-core.

## Server re-export shims

To keep the Express routes untouched, each moved `server/services/<name>.js` is a
thin shim that re-exports the bound functions from the assembled context, e.g.:

```js
import { services } from './_core.js'
export const { getClient, createClient /* … */ } = services.client
```
