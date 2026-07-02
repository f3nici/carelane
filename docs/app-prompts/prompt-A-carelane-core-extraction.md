# Prompt A — run this in the `carelane` repo

> Paste everything below the line into Claude Code, working in the `carelane`
> repository. It performs **Phase 0** of the standalone-app plan: extracting a
> shared, portable domain core. It deliberately does **not** build any sync
> engine or endpoints — that comes later. Read `docs/android-standalone-sync-design.md`
> first for the full context.

---

You are working in the `carelane` repo. Read `CLAUDE.md` and
`docs/android-standalone-sync-design.md` in full before touching anything.

## Goal

Extract CareLane's **portable domain logic** into a new package,
**`@carelane/core`**, that runs unmodified in BOTH Node (this server) and a React
Native app (a separate `carelane-app` repo, built later). The server must keep
behaving **exactly** as it does today — this is a pure refactor, no feature
changes, all existing tests green.

Do **not** build sync (no change-log tables, no `/sync` endpoints, no revision
columns). Sync is a later phase. Your only job is to make the domain logic
host-agnostic so a second host can reuse it.

## Why this shape

The app will be React Native (JS/TS), same language as this server, so the
domain logic can be single-sourced. The two things that make the current service
layer non-portable are (1) direct `better-sqlite3` / Drizzle singleton imports
and (2) `node:crypto` in `cryptoService`. Both must become **injected
dependencies** so each host supplies its own implementation.

## Tasks

### 1. Set up an npm workspace
- Convert the repo to npm workspaces with a `packages/core` package named
  `@carelane/core` (ESM, `"type": "module"`, matching the repo's style: no
  semicolons, single quotes, 2-space indent, JSDoc on exported functions).
- `@carelane/core` builds to `dist/` (compiled JS + `.d.ts`) via `tsc` (allow JS
  with `checkJs`/JSDoc types, or migrate the moved files to `.ts` — your call,
  but the published entry must be plain ESM JS the app's Metro bundler can
  consume without extra transpilation, plus type declarations).
- Add a root `build:core` script; wire it so `npm test` and the server still work.

### 2. Move the portable layer into `@carelane/core`
Move (don't fork) these, adjusting imports:
- `server/db/schema.js` — the Drizzle table definitions (shared source of truth).
- `server/utils/validators.js` — Zod schemas (already isomorphic).
- The **domain services** that are pure business logic:
  `clientService`, `agreementService`, `billingService`, `shiftService`,
  `scheduleService`, `recurrenceService`, `goalService`, `incidentService`
  (CRUD + lifecycle only — see §3 on PDF), `medicationService`,
  `restrictivePracticeService`, `templateService`, `clientDocumentService`
  (metadata logic only), `settingsService`, `deletedService`, `activityService`
  (the audit hash-chain — both hosts need it), and `accountService` (bcrypt via
  `bcryptjs`, which is pure JS and RN-safe).
- `cryptoService` — but refactored per §4.

Verify the real import graph before moving; the list above is guidance, not
gospel. If a "portable" service pulls in a server-only dependency, split the
portable part out and leave the rest behind.

### 3. Keep server-only capabilities in `server/`
These depend on Node-only or backend-only packages and must NOT enter the core:
- `aiService` (`@anthropic-ai/sdk`), `ragService` + `rerankService`
  (`@xenova/transformers`, `sqlite-vec`), `documentService` (`pdf-parse`,
  `mammoth`), `backupService` (`archiver`, fs), `squareService`,
  `googleCalendarService`, `ntfyService`, `metrics`, `swagger`.
- **PDF rendering** (`pdfkit`) for incident/report exports stays server-side.
  Split `incidentService` so record CRUD/lifecycle is in core and only the
  `export.pdf` rendering stays in `server/`.
- Auth/session machinery that is inherently server-side —
  `securityPolicyService`, `sessionService`, `passkeyService`, login throttling,
  rate limiting, CSRF — stays in `server/`. (The app will implement its own local
  device auth; it does not reuse these.)

### 4. Make persistence and crypto injected, not imported
- **Database:** the core services must not `import { sqlite, db } from
  '../db/connection.js'`. Instead they receive a Drizzle instance (and, where
  raw SQL/`sqlite` is used today — e.g. the audit chain and FTS triggers — a thin
  query interface) via a **context object** passed in at construction, e.g.
  `createServices({ db, sqlite, crypto, now })`. Both hosts build this context:
  the server with `better-sqlite3` (`drizzle-orm/better-sqlite3`), the app later
  with `op-sqlite` (`drizzle-orm/op-sqlite`). Keep the abstraction thin — do not
  invent a heavyweight ORM-over-ORM; a small repository/context seam is enough.
- **Crypto:** `cryptoService` must not hard-import `node:crypto`. Define a small
  `CryptoProvider` interface (scrypt key derivation, AES-256-GCM encrypt/decrypt,
  HMAC for the blind index, random IV) and inject it. Preserve the exact wire
  format (`enc:<iv>:<tag>:<ct>` base64, per-record IV, the `carelane-pii-v1` and
  `carelane-blind-index-v1` salts) so existing ciphertext stays readable. The
  server injects a `node:crypto` implementation; document that the app will inject
  `react-native-quick-crypto` (node-compatible API).
- **Clock:** inject a `now()` for testability (defaults to `Date.now`).

### 5. Rewire the server to consume the core
- `server/services/*` that moved now re-export from `@carelane/core` (or routes
  import from core directly) — whichever keeps route handlers untouched.
- Build the core's context once at server startup from the existing
  `better-sqlite3` connection + a `node:crypto` provider, and pass it in.
- The migration runner (`server/db/migrate.js`), `connection.js`, seed, and all
  routes keep working. The encryption canary must still pass. Audit-chain verify
  (`GET /api/v1/audit/verify`) must still pass.

### 6. Tests
- All existing Vitest tests must pass unchanged. If a test imported a moved
  module by path, update the import only.
- Add a minimal test proving the core works against an **in-memory** Drizzle DB
  with an injected crypto provider (no server, no `better-sqlite3` singleton) —
  this is the proof the app can reuse it.

## Constraints
- No behaviour changes, no schema/data changes, no new runtime deps in the
  server path beyond what the workspace split needs.
- Match existing style exactly (ESLint must pass: no-semi, single-quote,
  2-space). JSDoc on all exported core functions.
- Keep commits scoped and descriptive. Work on a feature branch; do not push to
  `main`.

## Done when
- `npm run build:core`, `npm test`, `npm run lint`, and `npm start` (dev) all
  succeed.
- `@carelane/core` has zero imports of `better-sqlite3`, `node:crypto`, or any
  server-only package listed in §3, and builds to a `dist/` the RN app can import.
- The new in-memory core test passes, demonstrating host-agnostic reuse.
- Write a short `packages/core/README.md` documenting the context object
  (`db`, `sqlite`, `crypto`, `now`), the `CryptoProvider` interface, and which
  services are in-core vs server-only — the app repo will read this.
</content>
