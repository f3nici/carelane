# CareLane

Self-hosted management tool for an independent NDIS support worker (Australia).

CareLane keeps participant records, service agreements, shift notes, billing and
reports in one place, with AI assistance for drafting paperwork. It is designed
to be run by a **single operator on their own infrastructure** — it is not a
multi-tenant SaaS. All data is treated as sensitive health information and
encrypted at rest.

> A `users` table and roles exist so additional worker logins can be added
> later, but the default deployment assumes one person.

## Features

- **Participants/clients** — encrypted PII, NDIS number searchable via a
  blind-index HMAC, soft-delete only.
- **Service agreements** — questionnaire → AI-drafted agreement → human review →
  explicit finalisation / client sign-off.
- **Shift notes** — encrypted note body and incident details, photo attachments,
  incident flagging.
- **Billing codes** — importable NDIS price-guide codes, deactivate (never delete).
- **Reports** — AI-assisted progress/summary reports rendered to PDF.
- **Knowledge base (RAG)** — upload PDFs/DOCX, search them with local embeddings
  and ask grounded questions.
- **Activity log** — append-only, PII-redacted audit trail.
- **Automated backups** — scheduled SQLite backups with retention.

## Tech stack

| Layer      | Choice |
|------------|--------|
| Frontend   | Vue 3 (`<script setup>`), Vite, Tailwind, Pinia, Vue Router |
| Backend    | Express 5, better-sqlite3, Drizzle schema |
| Search/RAG | sqlite-vec (JS cosine fallback), `@xenova/transformers` local embeddings |
| AI         | Claude API (`@anthropic-ai/sdk`) — Haiku for cheap tasks, Sonnet for quality |
| Docs/API   | swagger-jsdoc + swagger-ui (`/api/docs`) |
| Runtime    | Node.js (ESM), Docker, port `3778` |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    Edit .env — at minimum set SESSION_SECRET, ENCRYPTION_SECRET and
#    (optionally) ANTHROPIC_API_KEY for AI features.

# 3. Set up the database
npm run migrate     # apply idempotent SQL migrations
npm run seed        # create admin user + default settings + starter billing codes

# 4. Run in development (Express :3778 + Vite :5173 proxying /api)
npm run dev
```

Open <http://localhost:5173> and log in with `DEFAULT_USERNAME` /
`DEFAULT_PASSWORD` (default `admin` / `changeme` — change these).

- API documentation: <http://localhost:3778/api/docs>
- Health check: <http://localhost:3778/healthz>

## Scripts

```bash
npm run dev        # Express (:3778) + Vite (:5173, proxies /api)
npm run build      # build the frontend to dist/ (Express serves it in prod)
npm start          # production server (serves dist/ and the API)
npm run migrate    # apply idempotent SQL migrations
npm run seed       # admin user + default settings + starter billing codes
```

## Production / Docker

```bash
# Build the frontend then start the production server
npm run build
npm start

# …or with Docker
docker compose up -d        # serves on port 3778
```

In production the server serves the built frontend from `dist/` and exposes the
API on the same port. **The app refuses to start unless `SESSION_SECRET` and
`ENCRYPTION_SECRET` are set to real values.**

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)).

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `3778`). |
| `NODE_ENV` | `development` or `production`. |
| `SESSION_SECRET` | Session signing secret. **Required in production.** |
| `ENCRYPTION_SECRET` | AES-256-GCM key material for PII. **Required in production. Cannot be rotated casually — see warning below.** |
| `ANTHROPIC_API_KEY` | Claude API key; AI features are disabled without it. |
| `CLAUDE_MODEL_CHEAP` / `CLAUDE_MODEL_QUALITY` | Model IDs for cheap vs. quality tasks. |
| `DEFAULT_USERNAME` / `DEFAULT_PASSWORD` | Seeded admin login. |
| `DB_PATH` | SQLite database file path. |
| `UPLOAD_PATH` / `MAX_UPLOAD_SIZE` | Upload directory and per-file size cap (bytes). |
| `EMBEDDING_MODEL` | transformers.js embedding model for RAG. |
| `DEFAULT_PRICE_REGION` | NDIS price region for billing. |
| `BACKUP_ENABLED` / `BACKUP_PATH` / `BACKUP_RETENTION` / `BACKUP_TIME` | Scheduled backup settings. |
| `PUBLIC_API_ENABLED` | Toggle for the public API surface. |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated). |

> ⚠️ **`ENCRYPTION_SECRET` cannot be rotated casually.** Once data is encrypted
> with it, changing it makes all existing PII unreadable. Back it up securely.

## Architecture

```
server/
  routes/      thin HTTP handlers, Zod validation, standard response envelope
  services/    all business logic — encryption lives here, never in routes
  db/          Drizzle schema, migrations, seed, connection
  middleware/  auth, validation, error handling
  utils/       validators, pagination, PDF/DOCX helpers
src/
  pages/       route-level views          components/  reusable UI
  layouts/     app shell                  stores/      Pinia state
  composables/ useApi.js (axios + CSRF)   router/      Vue Router
```

Key design points:

- **Encryption is centralised** in `server/services/cryptoService.js`
  (AES-256-GCM, `enc:` prefix, per-record IV). Routes never touch raw crypto or
  ciphertext.
- **Standard response envelope** — `{ success, data, meta }` on success,
  `{ success: false, error }` on failure.
- **Append-only activity log** enforced by SQLite triggers; details are
  PII-redacted.
- **Uploads are auth-gated** — files under `uploads/` are served only through
  authenticated routes, never `express.static`.
- **RAG pipeline** — PDF/DOCX → per-page text → ~600-token chunks → local
  embeddings → `document_chunks.embedding` BLOB → search via sqlite-vec or JS
  cosine fallback.
- **AI is draft-only** — Claude output is always a draft; finalisation
  (`finalised` / `signed_by_client` / `status=final`) is an explicit human
  action enforced in services. Whole PDFs and full participant records are never
  sent to the API; inputs are minimised (initials, bullets, top-k chunks).

See [`CLAUDE.md`](CLAUDE.md) for the full development guide, hard rules and code
style conventions.

## Roadmap

Planned work, not yet implemented:

- **Square API invoicing** — integrate the Square API to automatically generate
  invoices from billable shifts and send them to participants. When an invoice
  is sent, the corresponding shift is automatically marked as billed, closing
  the loop between shift notes and payment.
- **Agreement & report templates** — reusable templates for service agreements
  and reports that Claude reads from and follows when drafting, so generated
  documents match a consistent, operator-defined structure and wording.

## Data & privacy

This application stores sensitive health information. Operators are responsible
for:

- Keeping `SESSION_SECRET` and `ENCRYPTION_SECRET` secret and backed up.
- Securing the host, database file and `uploads/` directory.
- Verifying scheduled backups.
- Reviewing all AI-generated drafts before finalising any document.

## License

ISC.
