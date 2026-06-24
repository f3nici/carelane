# CareLane — Development Guide

Self-hosted management tool for an independent NDIS support worker (Australia).
Single-operator by default; users table + roles exist so more worker logins can
be added later. NOT multi-tenant SaaS. All data is sensitive health information.

Licensed under MIT with the Commons Clause (source-available; free to use,
modify, fork and self-host — including a paid support-work practice — but the
Commons Clause forbids reselling it or hosting it as a paid service for others)
— see `LICENSE`. Optional outbound integrations (Anthropic, Google, Square,
Hugging Face) are each governed by the provider's own terms; the README lists
them. Security disclosures: `SECURITY.md`. Changes: `CHANGELOG.md`.

## Stack
Vue 3 (`<script setup>` only) + Vite + Tailwind + Pinia · Express + better-sqlite3
+ Drizzle schema · sqlite-vec (JS cosine fallback) · transformers.js local
embeddings · Claude API (`@anthropic-ai/sdk`) for drafting only · Docker, port 3778.

## Commands
```bash
npm run dev        # Express (:3778) + Vite (:5173, proxies /api)
npm run build      # build frontend to dist/ (Express serves it in prod)
npm start          # production server
npm run migrate    # apply idempotent SQL migrations
npm run seed       # admin user + default settings + starter billing codes
npm run restore    # interactive restore from a backup snapshot (stop server first)
npm run reset-password  # offline CLI to reset a forgotten login password
npm test           # Vitest unit + route integration tests
npm run lint       # ESLint (enforces no-semi / single-quote / 2-space style)
```
Default login: `DEFAULT_USERNAME`/`DEFAULT_PASSWORD` env (admin/changeme).
API docs at `/api/docs`, health at `/healthz`.

## Architecture
- `server/routes/*` — thin handlers, Zod validation (`utils/validators.js`),
  standard envelope `{ success, data, meta }` / `{ success:false, error }`.
- `server/services/*` — all business logic. **Encryption happens only here**
  (`cryptoService.js`, AES-256-GCM, `enc:` prefix, per-record IV). Routes never
  touch raw crypto or ciphertext.
- Encrypted columns: clients PII fields, shift `body`/`incident_details`.
  NDIS number also gets an HMAC blind index (`ndis_number_hash`) for search.
- `activity_log` is append-only (SQLite triggers) and tamper-evident: each row
  carries a SHA-256 hash chained off the previous row (`prev_hash`/`hash`),
  verifiable via `GET /api/v1/audit/verify` (Dashboard + Audit-log widgets).
  Details are PII-redacted at write time; `updated` actions record a field-level
  `changes` diff (`{field, from, to}`) with sensitive/health values redacted.
- Scheduling/roster: `scheduled_shifts` is the forward-looking plan (one-off or
  generated from a `shift_recurrences` series). Lifecycle: `scheduled` →
  `in_progress` (clock-in) → `completed` (clock-out, then a linked `shift_notes`
  record is created via `scheduleService.createNoteFromShift`) — or `cancelled`.
  `plan_notes` is encrypted like shift bodies. Recurrence occurrences are
  materialised into `scheduled_shifts` on a rolling 60-day horizon by a nightly
  cron (`recurrenceService.scheduleMaterialisation`); cancellations/edits are not
  re-created. Scheduled shifts are soft-deleted + restorable like other records.
  UI: the "Roster" page (`vue-cal` calendar + upcoming list + clock in/out).
- Google Calendar (optional, one-way push): `googleCalendarService` mirrors
  scheduled shifts to the operator's calendar via OAuth2 (native `fetch`, no SDK).
  App creds come from env (`GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI`); the
  refresh token is stored **encrypted** in `settings.google_refresh_token_enc`
  (a protected key). All sync is best-effort and a no-op until configured +
  connected + enabled — shift CRUD never blocks on it. Events carry only a short
  participant label (preferred name/initials) + location, never plan/health notes.
- Square Invoicing (optional): `squareService` turns a completed shift note into a
  **draft** invoice in the operator's Square account (never sent — sending it is a
  manual step in Square). The access token is a secret read from env
  (`SQUARE_ACCESS_TOKEN`, like the Anthropic key), never stored. The single line
  item is priced at the per-participant rate (`client_billing_codes.custom_rate`,
  falling back to the code's standard cap). The participant is mirrored to a Square
  customer (id cached on `clients.square_customer_id`) and set as the invoice's
  one `primary_recipient`; the plan-manager email is surfaced in the invoice
  description (Square allows only one recipient, and invoice custom fields need a
  paid Square plan). Each draft is tracked in `square_invoices` so a shift is
  never invoiced twice.
- ntfy push notifications (optional): `ntfyService` turns the dashboard's
  "needs attention" counts into proactive phone nudges via an
  [ntfy](https://ntfy.sh) topic — **plan reviews due** (active agreements nearing
  `end_date`), **incidents needing follow-up** (open/in-progress reports, overdue
  ones flagged) and **unbilled shifts aging** (finalised, `billed=0`, older than a
  threshold) — pushed as a once-daily digest at the operator's configured time,
  plus per-shift **reminders** a configurable lead time before a scheduled shift
  starts (deduped via `scheduled_shifts.reminder_sent_at`). All sync is
  best-effort and a no-op until a topic is set + enabled. Server URL, topic,
  per-category toggles, the request timeout (`ntfy_timeout_ms`, default 10s —
  generous so a slow/remote server isn't cut off) and timings are operator-editable
  settings (`ntfy_*`, defaults in `NTFY_DEFAULTS`, dedicated `/notifications`
  endpoints); only the optional access token (`NTFY_TOKEN`) comes from env. A
  single `* * * * *` cron drives both the reminder sweep and the digest, using the
  operator timezone (shared `google_calendar_timezone`). Messages carry only short
  labels + counts, never plan/health notes. See `docs/ntfy-notifications-setup.md`.
- Soft-deleted records (and deactivated billing codes) are listed and restorable
  via `GET /api/v1/deleted` + `POST /api/v1/deleted/:type/:id/restore` (the
  "Deleted Items" page) — clients, agreements, shifts, reports, templates,
  scheduled shifts, **consent/documents and goals**. Restores are themselves
  logged to the audit trail.
- Consent & document records: `client_documents` is a first-class, trackable
  store for completed paperwork (consent forms, signed agreements, …), not just
  generic uploads. Each row carries a `doc_type` (media_consent, consent_to_share,
  …) plus `issue_date`/`expiry_date`; the service computes an `expiry_status`
  (expired/expiring/ok) and the dashboard surfaces lapsing items
  (`GET /dashboard/document-expiries`, `documents_expiring` stat) before they
  lapse. Metadata is editable without re-uploading (`PUT
  /clients/:id/documents/:docId`). Files stay served auth-gated only.
- Incident reports: `incident_reports` promote a shift note's free-text incident
  flag into a structured, exportable record — NDIS reportable-incident fields
  (type, severity, the five reportable categories, reported-to-Commission status)
  plus a follow-up lifecycle (`open`→`in_progress`→`closed`, `closed_at` set on
  close). Narrative fields (description, immediate_actions, persons, witnesses,
  injuries, contributing_factors, notified_parties, follow_up_actions) are
  encrypted like shift bodies. `POST /incidents/from-shift/:shiftId` promotes an
  incident-flagged note (one report per note, seeded from `incident_details`);
  CRUD lives at `/incidents`. `GET /incidents/:id/export.pdf` renders a branded,
  auth-gated PDF. Dashboard surfaces `open_incident_reports` +
  `reportable_unreported` stats and an `incident-followups` list. Soft-deleted +
  restorable (`incident` type) like other regulated records.
- Restrictive-practice & medication logs: `restrictive_practice_records` (NDIS
  restrictive-practice register — type, authorisation/BSP ref, Commission
  reporting; narrative encrypted) and `medication_records` (a MAR — one row per
  administration, name/dose plain so the log is listable, reason/notes encrypted)
  are regulated record types nested under a participant
  (`clients/:id/restrictive-practices`, `clients/:id/medications`). Both
  soft-delete + restore (`restrictive_practice` / `medication` types) and log to
  the audit trail; UI lives in client-detail tabs.
- Offline shift-note capture (PWA): new notes saved while offline (or when a save
  hits a network error) are parked in IndexedDB (`composables/offlineDrafts.js`,
  store `stores/offline.js`) and flushed automatically on reconnect — the one
  place participant data is stored client-side, deleted the instant it syncs. The
  queue is plain same-origin IndexedDB. `OfflineIndicator` shows status + pending
  count + a manual "sync now". The service worker (`public/sw.js`) caches the
  **non-sensitive app shell** (built HTML/JS/CSS + branding) so the SPA boots with
  no signal, but never caches API responses, uploads or anything with PII.
  Offline UX is gated: a known prior session is kept signed in (`auth` persists
  only the worker's own name/role to `localStorage`, never participant data), the
  API interceptor suppresses "network error" toasts while offline, and the router
  funnels every non-note route to a dedicated `/offline` page (`OfflinePage.vue`)
  — the only things that work offline are the offline home and the new-note form,
  which picks its participant from a cached roster (`offline.clients`, id+names
  only, refreshed on each online load). Routes opt in via `meta.offlineReady`.
- Structured goals: `client_goals` are discrete, trackable participant outcomes
  (status active/achieved/on_hold/discontinued, optional target date) that
  supersede the free-text `clients.support_goals` blob (kept as a quick-notes
  fallback). Each goal accrues dated `goal_progress_notes` whose `body` is
  encrypted like shift bodies. The report drafter prefers a structured goals +
  recent-progress summary (`goalService.buildGoalsSummary`) over the free-text
  field. CRUD nests under `clients/:id/goals` (+ `…/goals/:goalId/progress`).
- Uploads (photos/documents/logos/pdfs) live under `uploads/` and are served
  **only via auth-gated routes** — never `express.static`.
- RAG: PDF → per-page text → ~300-token chunks → local embeddings
  (`bge-small-en-v1.5`, query-instruction prefix) → `document_chunks.embedding`
  BLOB. Search is **hybrid**: vector (sqlite-vec or JS cosine) + BM25 keyword
  (`document_chunks_fts` FTS5, kept in sync by triggers) fused with Reciprocal
  Rank Fusion, then reordered by a local cross-encoder reranker
  (`rerankService`, degrades gracefully if unavailable). The embedding model is
  recorded per document (`documents.embedding_model`); changing it warns on
  startup until each stale document is re-indexed (`npm run reindex` or the UI
  re-index button). Original PDFs download via auth-gated `GET /documents/:id/file`.
- AI: Haiku for cheap tasks (note cleanup, condensing), Sonnet for agreements/
  reports/Q&A. Stable system block uses prompt caching. Inputs are minimised
  (preferred name/initials, bullets, top-k chunks). Usage logged per call.
  Drafting is operator-toggleable (`claude_enabled` setting, default on): when
  off, the draft/ask services refuse (`AI_DISABLED`) and the SPA hides every AI
  tip/panel (estimated-token hints, "used for the AI draft" notes, the
  Knowledge "Ask Claude" mode) — gated app-wide via `useIntegrations`. Optional
  integrations (Claude, Google Calendar, Square, ntfy) each show a uniform
  On / Off / Not configured status tag in Settings.

## Hard rules
- Never hard-delete regulated records (clients, agreements, shifts, reports,
  billing) — `deleted_at` soft delete only. Billing codes deactivate, not delete.
- Never send whole PDFs or full participant records to the Claude API.
- AI output is always a draft; finalisation is an explicit human action
  (`finalised`/`signed_by_client`/`status=final`) enforced in services.
- Production refuses to start without real `SESSION_SECRET`/`ENCRYPTION_SECRET`.
- `ENCRYPTION_SECRET` cannot be rotated casually — existing ciphertext becomes
  unreadable. Document/backup it. A startup **encryption canary** (sealed in
  `settings.enc_canary`) refuses to boot if the secret no longer matches.
- Incident-flagged shift notes cannot be deleted.
- `/auth/login` is brute-force throttled (per ip+username) and supports optional
  TOTP 2FA; the TOTP secret + recovery-code hashes are encrypted at rest like
  any other PII (in `twoFactorService`, never in routes). The login form always
  shows the 2FA code field (left blank when the account has no 2FA). The throttle
  and the per-route rate limiters are **DB-backed** (`throttle_hits` table, via
  `loginThrottle.js` / `rateLimit.js`) so lockouts survive restarts and hold
  across workers; expired buckets are purged hourly + lazily.
- Operator security policy (`securityPolicyService`): the admin can require a
  second factor (TOTP **or** a passkey) on every login (`require_2fa` setting,
  guarded `GET/PUT /auth/security-policy`). Enforcement is lockout-safe — a
  password login for an account without a second factor still succeeds but is
  flagged `must_enrol_2fa`, and the SPA router funnels it to Settings to enrol.
  Enabling the policy is blocked unless the acting admin already has a factor.
- Active sessions / trusted devices (`sessionService`): each login stamps device
  metadata (created/last-seen, IP, truncated UA) on the session; the operator
  lists their sessions and revokes any remotely (`GET /auth/sessions`,
  `DELETE /auth/sessions/:sid`, `POST /auth/sessions/revoke-others`). Ownership
  is verified before a session id can be revoked.
- Observability: structured logging (`logger.js`, JSON in prod via `LOG_FORMAT`)
  with an access log recording method/route/status/duration only (never query
  strings or bodies). Access-log verbosity is `LOG_HTTP` (`config.httpLog`):
  `all`, `sampled` (default — drops routine successful 2xx/3xx GET/HEAD reads but
  keeps writes + all 4xx/5xx, so `docker logs` isn't flooded by status polling),
  `errors`, or `off`. Optional Prometheus scrape at `GET /metrics`
  (`METRICS_ENABLED`/`METRICS_TOKEN`) exposing HTTP counters/latency + app
  gauges; mounted before the auth stack like `/healthz`. See
  `docs/metrics-setup.md`.
- Passkeys (WebAuthn) are a passwordless login factor (`passkeyService.js`,
  `@simplewebauthn`). Each authenticator is a `webauthn_credentials` row; public
  keys are non-secret (not encrypted) and the in-flight challenge lives on the
  session. Passkey *login* endpoints (`/auth/passkeys/login/*`) are CSRF-exempt
  (the WebAuthn challenge is the anti-forgery guard); registration/management
  sits behind the normal auth+CSRF gate. RP id/origin auto-derive from the
  request unless pinned via `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`.
- Passwords are bcrypt-hashed (cost 12, `accountService.js`). Logged-in users
  change theirs in Settings (current password required); a forgotten password is
  reset offline via `npm run reset-password` — never over the API.
- Backups can be restored only via the offline `npm run restore` CLI (never over
  the API); a stale-backup warning logs on startup.

## Style
ES modules, no semicolons, single quotes, 2-space indent. Vue Composition API
with `<script setup>` exclusively. Tailwind only (palette in
`tailwind.config.js`). Axios via `src/composables/useApi.js` (adds CSRF header,
unwraps envelope). JSDoc on all service functions and route handlers.
Dates ISO 8601, money as numbers (2dp), booleans 0/1.
