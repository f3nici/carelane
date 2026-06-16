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
- **Activity log** — append-only, PII-redacted audit trail, with a filterable
  audit-log viewer (per entity / action / date) for NDIS auditing.
- **Backups** — scheduled SQLite backups with retention, integrity verification,
  a stale-backup startup warning, and an offline restore CLI (`npm run restore`).
- **Login hardening** — brute-force rate limiting on login and optional TOTP
  two-factor authentication (with one-time recovery codes).
- **Encryption canary** — refuses to boot if `ENCRYPTION_SECRET` no longer
  matches existing ciphertext, rather than silently returning unreadable PII.
- **Participant data export** — one-click "download everything" (PDF + JSON zip)
  for data-access requests.

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
npm run restore    # interactive restore from a backup snapshot (stop server first)
npm test           # Vitest unit + route integration tests
npm run lint       # ESLint (no-semicolons / single-quote / 2-space style)
npm run lint:fix   # auto-fix lint issues
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
| `EMBEDDING_MODEL` | transformers.js embedding model for RAG (default `Xenova/bge-small-en-v1.5`). Changing it requires `npm run reindex`. |
| `EMBEDDING_QUERY_PREFIX` | Optional query instruction prefix (auto-set for bge models). |
| `SEARCH_CANDIDATE_POOL` | Candidates pulled per arm (vector + BM25) before fusion/rerank. |
| `RERANK_ENABLED` / `RERANKER_MODEL` | Local cross-encoder reranker for the knowledge base. |
| `DEFAULT_PRICE_REGION` | NDIS price region for billing. |
| `BACKUP_ENABLED` / `BACKUP_PATH` / `BACKUP_RETENTION` / `BACKUP_TIME` | Scheduled backup settings. |
| `PUBLIC_API_ENABLED` | Toggle for the public API surface. |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Optional one-way Google Calendar sync. See the [Google Calendar setup guide](docs/google-calendar-setup.md). |

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

Planned work is tracked in the [Roadmap issue (#7)](https://github.com/f3nici/carelane/issues/7).

## Data & privacy

This application stores sensitive health information. Operators are responsible
for:

- Keeping `SESSION_SECRET` and `ENCRYPTION_SECRET` secret and backed up.
- Securing the host, database file and `uploads/` directory.
- Verifying scheduled backups.
- Reviewing all AI-generated drafts before finalising any document.

## Third-party services & their terms

CareLane runs fully self-hosted, but several **optional** features call out to
third-party services. Each is disabled until you configure it. When you enable
one, you are using that provider under **their** terms — review them before
sending any data, and remember CareLane only ever sends minimised inputs (see
[Data & privacy](#data--privacy)):

| Service | Used for | Required? | Terms / policies |
|---------|----------|-----------|------------------|
| **Anthropic (Claude API)** | AI drafting of agreements, reports, note cleanup and Q&A | Optional (no AI features without `ANTHROPIC_API_KEY`) | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) · [Usage Policy](https://www.anthropic.com/legal/aup) · [Privacy Policy](https://www.anthropic.com/legal/privacy) |
| **Hugging Face** | Downloading the local embedding & reranker models (`@xenova/transformers`) on first run | Effectively required for the knowledge base (models cached locally after download; inference runs on your own machine) | [Terms of Service](https://huggingface.co/terms-of-service) · [Privacy Policy](https://huggingface.co/privacy) |
| **Google Calendar** | One-way push of scheduled shifts to your calendar | Optional ([setup guide](docs/google-calendar-setup.md)) | [Google Terms of Service](https://policies.google.com/terms) · [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) · [Privacy Policy](https://policies.google.com/privacy) |
| **Square** | Creating draft invoices from completed shifts | Optional ([setup guide](docs/square-invoicing-setup.md)) | [Developer Terms of Service](https://developer.squareup.com/us/en/terms) · [General Terms](https://squareup.com/au/en/legal/general/ua) · [Privacy Notice](https://squareup.com/au/en/legal/general/privacy) |
| **Docker Hub** | Pulling/publishing the container image (deployment only) | Optional (only if you use the published image) | [Terms of Service](https://www.docker.com/legal/docker-terms-service/) · [Privacy Policy](https://www.docker.com/legal/docker-privacy-policy/) |

As the operator you are the data controller for the participant information you
hold. Confirm each provider's terms are compatible with your NDIS and Australian
privacy obligations before enabling an integration.

## Security

Found a vulnerability? Please report it privately — see
[`SECURITY.md`](SECURITY.md). Do not open a public issue for security reports.

## Releases & changelog

Releases are tracked on
[GitHub Releases](https://github.com/f3nici/carelane/releases), each with a
version tag you can pull (e.g. `git checkout 0.5.2`) and auto-generated notes.
See [`CHANGELOG.md`](CHANGELOG.md) for unreleased changes and where to find the
full history.

## License

Licensed under the **[MIT License with the Commons Clause](LICENSE)**.

CareLane is source-available and free to **use, modify, self-host and fork** —
including running your own (paid) support-work practice with it: tracking
participants, keeping notes, and sending invoices. Fork it, change it, share
your changes — all fine.

The one thing the Commons Clause forbids is **selling the software itself** —
which it explicitly defines to include **hosting it as a paid service / SaaS for
others** or charging fees whose value derives substantially from CareLane's
functionality. In short: build on it and run your own business with it, but
don't turn CareLane into a product you sell or rent to other people.

> Note: the Commons Clause removes the right to "Sell", so strictly speaking
> this is a *source-available* licence rather than an OSI-approved open-source
> one. Want to offer CareLane commercially (host it for others, sell it)? Contact
> <admin@fenici.com.au> for a separate licence.
