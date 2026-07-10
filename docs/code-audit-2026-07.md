# CareLane — Full Code Audit (July 2026)

Scope: the entire server (`server/`, `packages/core/`), the security-relevant
frontend surfaces (`src/composables/useApi.js`, `src/stores/auth.js`,
`src/router/index.js`, `public/sw.js`, `src/composables/offlineDrafts.js`),
Docker/compose packaging, and the test suite. Every route file, every
middleware, and every service that touches auth, crypto, files, money or
participant data was read. The full test suite was run (236 tests across 31
files, all passing) and the two behavioural findings below were reproduced with
a throwaway integration test before being recorded here.

Overall this is a well-built, security-conscious codebase. Encryption-at-rest
(AES-256-GCM, per-record IV, boot canary), the tamper-evident audit hash-chain,
blind-index FTS search, double-submit CSRF, DB-backed brute-force throttling,
upload magic-byte sniffing, literal-host SSRF guarding, and PII minimisation on
every outbound call are all implemented carefully and match the documentation.
The findings are gaps against the application's own stated security model, not
general sloppiness.

## Status

All findings and observations below have since been **resolved** in this branch
(see the "Resolution" note under each, and the accompanying tests). The full
suite passes (240 tests) with lint clean.

## Findings

### 1. Deactivated / role-changed accounts can still establish a fresh session — Medium — FIXED

`attachAccess` (`server/middleware/auth.js`) reloads the user on every
`/api/v1` request and rejects inactive accounts, so **data** routes are safe.
But the login paths themselves never check `users.active`:

- `POST /auth/login` (`server/routes/auth.js`) verifies password + TOTP only.
- `finishLogin` (`server/services/passkeyService.js`) resolves the user with no
  `active` check.

Reproduced: after an admin sets `active = 0` on a worker, that worker can still
`POST /auth/login` → **200**, reach `/auth/me` (200) and every other `/auth/*`
surface (change password, manage 2FA/passkeys, list/revoke sessions). Only the
participant-data routes return 401 via `attachAccess`. This contradicts the
documented intent that deactivating a departing worker revokes their access —
deactivation destroys *existing* sessions but nothing blocks a *new* login.

Related root cause: the `/auth` router runs `requireAuth` + `requireAdmin`
**without** `attachAccess`, so `requireAdmin` falls back to the session-stamped
`req.session.role`, which is set once at login and never refreshed. A stale
admin session therefore survives a live demotion for the admin-only
`/auth/security-policy` routes, inconsistent with the "role change takes effect
on the next request" guarantee that holds elsewhere.

Resolution: `POST /auth/login` now rejects a deactivated account with 403
`ACCOUNT_INACTIVE`; `finishLogin` refuses a passkey assertion for an inactive
account; and the admin-only `/auth/security-policy` routes now run `attachAccess`
so the role is re-derived from a fresh user read instead of the login-time
session stamp. Covered by `test/deactivatedLogin.routes.test.js`.

### 2. A support worker can set `billed = 1` on their own draft note — Low — FIXED

`billed` is in the shift-note `COLUMNS`
(`packages/core/src/services/shiftService.js`) and `canEditNote`
(`server/routes/shifts.js`) permits a worker to edit their own draft, so a
worker can flip the billing flag (reproduced: `PUT /shifts/:id {billed:1}` →
200, `billed=1`). CLAUDE.md treats billing and rates as an operator-only concern
hidden from workers. No data exposure, but the billing flag ideally should not
be worker-writable.

Resolution: the shift-note update route now strips `billed` from a non-admin
caller's payload, so a worker can still write their own draft but cannot change
its billing status. Covered by `test/deactivatedLogin.routes.test.js`.

### Lower-severity observations (all resolved)

- **SSRF on operator-set URLs is literal-only** (`isPrivateHost` in
  `packages/core/src/validators.js`): a public hostname that resolves to a
  private IP was not caught. **Fixed** — `ntfyService.publish` now resolves the
  configured host via DNS and refuses to send if any answer is a private /
  loopback / link-local address, closing the documented gap. Covered by
  `test/ntfySsrf.test.js`. (A residual TOCTOU between resolve and fetch remains,
  inherent to resolve-time SSRF checks.)
- **`/metrics` was fully open when `METRICS_TOKEN` is unset** — **Fixed** —
  token-less scrapes are now served only to a private / loopback source address
  (the endpoint's intended internal-scrape use); a public client without a token
  is refused. Set `METRICS_TOKEN` to scrape from a public address. Covered by
  `test/metrics.test.js`.
- **Google OAuth `state` compared with `!==`** (`server/routes/schedule.js`) —
  **Fixed** — the state nonce is now compared with the constant-time
  `timingSafeStrEqual` helper, mirroring the CSRF-token check.

## Verified correct (spot-checks that passed)

- Encryption canary + AES-256-GCM per-record IV; refuses to boot on secret
  mismatch.
- Audit hash-chain append atomicity (`BEGIN IMMEDIATE`); PII redaction at write
  time; field-level change diffs redacted by field name.
- Blind-index FTS never stores note plaintext; tokenisation happens in the app
  layer, never a SQL trigger.
- `updateShift` refuses `client_id` changes and always re-derives duration
  server-side (never client-supplied).
- Finalised/signed guards on notes, reports and agreements; AI output is always
  a draft.
- Share-link and calendar-feed tokens are the sole credential, served outside
  the session/CSRF stack, redacted from the access log, and both re-check
  `active` on resolve.
- Upload magic-byte verification with on-disk extension normalisation; SVG logo
  served with a locked-down CSP + `nosniff`.
- Timing-safe CSRF and metrics-token comparisons; TOTP replay defence via a
  counter high-water mark.
- Last-admin guard on user updates; demo-mode lockdowns on uploads, exports,
  backups, AI and account-security writes.

## Method

- Static read of all server routes, core services, middleware, crypto, and the
  security-relevant frontend files.
- `npm test` — 236 tests / 31 files, all passing.
- Two findings reproduced with a temporary supertest integration test (removed
  after confirmation): deactivated-account login returning 200, and a worker
  setting `billed=1` on their own draft note.
