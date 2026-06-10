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
- `activity_log` is append-only (SQLite triggers); details are PII-redacted.
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
  unreadable. Document/backup it.
- Incident-flagged shift notes cannot be deleted.

## Style
ES modules, no semicolons, single quotes, 2-space indent. Vue Composition API
with `<script setup>` exclusively. Tailwind only (palette in
`tailwind.config.js`). Axios via `src/composables/useApi.js` (adds CSRF header,
unwraps envelope). JSDoc on all service functions and route handlers.
Dates ISO 8601, money as numbers (2dp), booleans 0/1.
