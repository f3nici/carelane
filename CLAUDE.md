# CareLane — Development Guide

Self-hosted management tool for an independent NDIS support worker (Australia).
Single-operator by default; users table + roles exist so more worker logins can
be added later. NOT multi-tenant SaaS. All data is sensitive health information.

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
- Soft-deleted records (and deactivated billing codes) are listed and restorable
  via `GET /api/v1/deleted` + `POST /api/v1/deleted/:type/:id/restore` (the
  "Deleted Items" page). Restores are themselves logged to the audit trail.
- Uploads (photos/documents/logos/pdfs) live under `uploads/` and are served
  **only via auth-gated routes** — never `express.static`.
- RAG: PDF → per-page text → ~600-token chunks → local embeddings →
  `document_chunks.embedding` BLOB; search via sqlite-vec or JS cosine.
- AI: Haiku for cheap tasks (note cleanup, condensing), Sonnet for agreements/
  reports/Q&A. Stable system block uses prompt caching. Inputs are minimised
  (preferred name/initials, bullets, top-k chunks). Usage logged per call.

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
  any other PII (in `twoFactorService`, never in routes).
- Backups can be restored only via the offline `npm run restore` CLI (never over
  the API); a stale-backup warning logs on startup.

## Style
ES modules, no semicolons, single quotes, 2-space indent. Vue Composition API
with `<script setup>` exclusively. Tailwind only (palette in
`tailwind.config.js`). Axios via `src/composables/useApi.js` (adds CSRF header,
unwraps envelope). JSDoc on all service functions and route handlers.
Dates ISO 8601, money as numbers (2dp), booleans 0/1.
