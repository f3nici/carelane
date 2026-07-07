# CareLane — Development Guide

Self-hosted management tool for an independent NDIS support worker (Australia).
Single-operator by default, but supports multiple logins with scoped access
(admin + support workers — see the multi-user access-control note under
Architecture). NOT multi-tenant SaaS. All data is sensitive health information.

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
- Multi-user access control: two roles — `admin` (the operator) and `worker`
  (support worker). `client_assignments` (user↔client) grants a worker access to
  specific participants; an admin sees everything. Enforcement is server-side:
  `attachAccess` (middleware, runs after `requireAuth`) loads the user fresh
  (reflecting deactivation/role changes immediately) and sets `req.isAdmin` +
  `req.assignedClientIds` (null for admin). Detail routes gate via a
  `router.param('id', …)` that resolves the record's participant and calls
  `assertClientAccess`; list routes pass `client_ids: req.assignedClientIds` into
  the core `list*` functions (which scope via `applyClientScope`). Rosters are
  scoped by `scheduled_shifts.worker_id` instead — a worker sees/clocks only
  their own shifts; an admin assigns each shift a `worker_id`. Workers are
  otherwise **read-only** on the participant record (view every note/incident/
  goal/med/RP/document, but never edit, delete or finalise them). Service
  agreements, the per-participant charge rate (`custom_rate` + price caps, stripped
  from the billing-codes read) and the full-record export are hidden from workers
  entirely, and a worker's dashboard shows only their upcoming shifts. The
  exceptions are shift notes and their own roster: a worker may create a note,
  and edit/finalise/attach-photos to their OWN note **while it is a draft** — once
  finalised they can neither edit it nor send it back to draft (only an admin
  reopens), and they can never touch someone else's note (`canEditNote` guard in
  `routes/shifts.js`). They also clock in/out of their own roster.
  `accessService`/`userService` (server-only) manage assignments and user CRUD
  (`/api/v1/users`, admin only; last-admin guard). Users are never hard-deleted —
  a departing worker is deactivated (`users.active=0`), revoking their sessions.
  Operator surfaces (notifications, invoices, templates, audit log, deleted-items)
  are admin-only; billing codes and the knowledge base (RAG search + grounded
  Q&A) are usable by all (a worker picks a code on a note, searches/asks the
  guidelines and downloads source PDFs) but only an admin edits codes or uploads/
  re-indexes/deletes documents. AI drafting
  follows the note-edit rule — a worker can AI-draft their OWN draft note — and
  the whole AI surface degrades to nothing when Claude is off/unconfigured
  (`useIntegrations`/`aiActive`). Settings *reads* (branding + AI status) are open
  to all — the app needs them — but every settings *write* keeps its own
  `requireAdmin` (secrets are stripped from the read). Access failures return 401
  `UNAUTHENTICATED` ("not authenticated") or 403 `FORBIDDEN` ("you don't have
  access"). The SPA hides admin-only nav/controls (`auth.isAdmin`, router
  `meta.adminOnly`).
- Encrypted columns: clients PII fields, shift `body`/`incident_details`.
  NDIS number also gets an HMAC blind index (`ndis_number_hash`) for search.
- Shift-note keyword search: the note list (`listShifts`) supports a free-text
  `q` (plus participant, date/date-range filters and a date/participant `sort`).
  Because `body`/`incident_details` are encrypted at rest, search runs over a
  **blind-index FTS5 table** (`shift_notes_fts`): each note's words are reduced
  to keyed per-word HMACs (`searchToken`, reusing the crypto blind-index key) in
  the app layer — never a SQL trigger — so no note plaintext is written to the
  index. A query is hashed the same way and matched via `MATCH`, keeping search
  a paginated SQL query that scales (whole-word, case-insensitive; multi-word is
  AND-ed). Maintained on every create/update by `shiftService.indexShift`;
  `reindexSearch` backfills missing rows (run by the migration, self-healing on
  boot). Participant sort still decrypts in JS (encrypted legal name).
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
- Calendar feed (read-only iCal/.ics): `calendarFeedService` exposes each user's
  roster as a subscribable feed any calendar app (Google/Apple/Outlook) can add.
  Auth is a per-user secret token (`users.calendar_feed_token`, unique) carried in
  the URL — the feed is served **unauthenticated** at `GET /calendar/:token.ics`,
  mounted before the `/api` session+CSRF stack (a calendar client sends no cookie;
  the token *is* the credential). The token is generated/rotated/cleared via
  `/schedule/calendar-feed` (any authenticated user, not admin-only — a worker
  subscribes to their own roster); rotating revokes old links. The feed is scoped
  exactly like the roster list (admin → all shifts, worker → own via `worker_id`),
  windowed to a bounded past/future range, excludes cancelled/deleted shifts, and
  — like the Google push — carries only a short participant label + location +
  times, never plan/health notes. The secret path is redacted from the access log
  (and never appears in metrics, which are path-free). UI: a "Calendar
  subscription" panel on the Roster page.
- Client-facing share links (`shareLinkService`, `share_links` table): a
  time-limited, audited, read-only link that lets a plan manager or the
  participant fetch ONE specific **finalised report** or **completed PDF
  document** without a CareLane account. Only PDFs are ever shared — a report
  renders to PDF and a document must be a PDF (image/other file types are
  refused). Like the calendar feed, the unguessable token in
  the URL is the only credential, so the public endpoints are served
  **unauthenticated** and OUTSIDE the `/api` session+CSRF stack — `GET /share/:token`
  is a minimal branded landing page (a safe resource title + short participant
  label, never report/health content, so a link-preview scanner pulls nothing)
  and `GET /share/:token/download` is the actual fetch. Every download is counted
  (`view_count`/`last_viewed_at`) and written to the append-only audit trail
  (`share_link` entity, `accessed` action, no acting user); the secret path is
  redacted from the access log. Each link is bound to a single resource +
  participant, carries an `expires_at` (default 14 days) and an optional
  `max_views` cap — `linkState` derives active/expired/revoked/exhausted. Only
  finalised reports are shareable (a draft is never exposed). Reports render their
  PDF on the fly at fetch time (reflecting edits); PDF documents stream the stored
  file. Creating/listing/revoking links is **admin-only** (`/api/v1/share-links`,
  behind `requireAdmin`) — sharing exposes participant data externally, so a
  worker never does it; links are revoked (soft), never hard-deleted, so the
  audit history stays. `demoLock` blocks link creation and the public download in
  demo mode. UI: a "Client share links" panel on the report detail page and a
  per-document "share" action in the participant documents tab.
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
  /clients/:id/documents/:docId`). An expiring/expired document can be
  **acknowledged** (`acknowledged` flag → `acknowledged_at`): it stays on the
  participant record but drops off the dashboard list + count. Files stay served
  auth-gated only.
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
- Public demo mode (`demoService.js`, `DEMO_MODE` env, off by default): boots a
  throwaway showcase with two shared logins (a `demo` admin + a `demoworker`
  worker, both password `demo`) and a full fabricated dataset (participants,
  agreements, shift notes, an incident, goals, meds, RP logs, consent docs, a
  report, roster), seeded via the core services so encryption/blind-index/search
  all run normally. `resetDemoData` **hard-deletes** all operational tables
  (child→parent, dropping the append-only `activity_log` triggers to clear it)
  and reseeds; `scheduleDemoReset` runs it at boot + every `DEMO_RESET_HOURS`
  (default 6). The login screen reads `GET /auth/config` (unauthenticated) to
  pre-fill + advertise the demo creds; `demo` is surfaced on `/auth/me` + login
  so the SPA hides the locked controls. A `demoLock` middleware returns 403
  `DEMO_LOCKED` on the account-security and user-management writes (password /
  2FA / passkey change, `require_2fa` policy, user create/update/reset/assign) so
  a visitor can't lock others out. `demoLock` also guards the ntfy notification
  writes (settings save, test/send-now/clear-error) so a visitor can't drive
  outbound pushes from the host's IP; the SPA disables those controls in demo
  mode too. To stop a public visitor overloading the host's disk/CPU, `demoLock`
  additionally blocks every **file upload** (logo, price-guide import, knowledge
  PDFs, participant documents, shift photos — the periodic reset clears DB rows
  but not on-disk files, so uploads would accumulate unbounded) and the
  **resource-heavy, spammable work**: manual backups (`/settings/backups/run`,
  which copies the whole DB + uploads) and the generative exports (participant
  full-record JSON/`export.zip`, and the on-the-fly PDF renders for incidents,
  reports and agreements). Lightweight auth-gated file *serving* (the branding
  logo, plus the small seeded placeholder documents) stays available so the
  download feature is still demonstrable; scheduled nightly backups are also
  skipped in demo mode. `demoLock` also blocks the **AI drafting/Q&A** endpoints
  (shift/report/agreement `…/draft` + knowledge `ask`) so a visitor can't spend
  the host's Claude tokens even if a key is configured; the SPA hides the whole
  AI surface in demo via `aiActive` (forced off when `auth.isDemo`). Because the
  demo login is shared, `listUserSessions` **redacts each session's IP** in demo
  mode so one visitor's address is never shown to another. The SPA hides/disables
  all of these upload/export/backup/AI controls in demo mode too. Everything is
  gated on `config.demoMode` and a no-op otherwise — **never enable it on real
  data.**
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
- Observability: structured logging (`logger.js`) with an access log recording
  method/route/status/duration only (never query strings or bodies). `LOG_FORMAT`
  picks the renderer: `pretty` (readable, aligned single lines — the request log
  gets a dedicated `<time> <LEVEL> <METHOD> <status> <path> <ms>` layout; the
  docker-compose default) or `json` (one object per line for shippers; the prod
  default when unset). Optional Prometheus scrape at `GET /metrics`
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
