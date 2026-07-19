# CareLane

Self-hosted management tool for an independent NDIS support worker (Australia).

CareLane keeps participant records, service agreements, shift notes, billing and
reports in one place, with AI assistance for drafting paperwork. It is designed
to be run by a **single operator on their own infrastructure** — it is not a
multi-tenant SaaS. All data is treated as sensitive health information and
encrypted at rest.

> **🔎 Try the live demo: <https://carelane.feni.ci>** — sign in with `demo` /
> `demo` (just press **Sign in**; it's pre-filled). Example data only, and it
> resets every few hours. See [Public demo mode](#public-demo-mode).

> The default deployment assumes one person, but CareLane supports **multiple
> logins with scoped access**: an admin manages the practice and can add support
> workers who each see only the participants assigned to them and only their own
> roster, read-only. See _Team & access control_ below.

## Features

- **Participants/clients** — encrypted PII, NDIS number searchable via a
  blind-index HMAC, soft-delete only.
- **Service agreements** — questionnaire → AI-drafted agreement → human review →
  explicit finalisation / client sign-off.
- **Shift notes** — encrypted note body and incident details, photo attachments,
  incident flagging. Draft notes **offline in the field** (PWA) and they sync
  automatically when you reconnect.
- **Incident reports** — promote an incident-flagged shift note into a
  structured, exportable record with NDIS reportable-incident fields and a
  follow-up status; download as a branded PDF.
- **Restrictive-practice & medication logs** — regulated registers per
  participant (restrictive-practice use with authorisation/Commission reporting,
  and a medication administration record), encrypted at rest.
- **Billing codes** — importable NDIS price-guide codes, deactivate (never delete).
- **Reports** — AI-assisted progress/summary reports rendered to PDF.
- **Knowledge base (RAG)** — upload PDFs, search them with local embeddings
  (hybrid vector + BM25, locally reranked) and ask grounded questions.
- **Activity log** — append-only, PII-redacted audit trail, with a filterable
  audit-log viewer (per entity / action / date) for NDIS auditing.
- **Backups** — scheduled SQLite backups with retention, integrity verification,
  a stale-backup startup warning, and an offline restore CLI (`npm run restore`).
- **Scheduling / roster** — forward-looking shift plan (one-off or recurring
  series materialised on a rolling horizon), clock in/out lifecycle, an optional
  one-way push of shifts to Google Calendar, and a read-only iCal (`.ics`) feed
  each user can subscribe to from any calendar app.
- **Square invoicing (optional)** — turn a completed shift note into a *draft*
  invoice in your Square account (sending stays a manual step in Square). Unlike
  the other integrations, enabling this sends the participant's **name, email and
  phone** to Square (Block, Inc.) to create the invoice recipient — invoicing
  needs a real addressee, so these fields are not minimised. Leave it off if you
  don't want participant contact details leaving your host.
- **Push notifications (optional)** — proactive [ntfy](https://ntfy.sh) nudges to
  your phone for plan reviews due, incidents needing follow-up, unbilled shifts
  aging, and a reminder before each upcoming shift. Set the topic, toggles and
  timings in-app. See the [ntfy setup guide](docs/ntfy-notifications-setup.md).
- **Team & access control** — add support-worker logins alongside the admin, and
  assign each worker the participants they support (managed from the **Team**
  page). A worker sees only their assigned participants, mostly **read-only**:
  they can view every note, agreement, incident, goal and record but not change
  them. The exception is their own shift notes — a worker can write a note, and
  edit/finalise it **while it is a draft**; once finalised only an admin can
  reopen it. Rosters are per-worker: an admin assigns each scheduled shift to a
  worker, and a worker sees (and clocks in/out of) only their own shifts; their
  dashboard shows just their upcoming shifts. Workers can search/ask the
  knowledge base, download its source PDFs and AI-draft their own notes (when
  Claude is configured) — they just can't upload documents. Service agreements,
  the rate a participant is charged, and the full-record export are hidden from
  workers. Everything else (settings changes, billing-catalogue editing,
  incident/agreement/report authoring, the audit log and deleted-items recycle
  bin) stays admin-only.
- **Login hardening** — DB-backed brute-force throttling (per ip+username and a
  per-account global counter, surviving restarts), optional **TOTP two-factor**
  with one-time recovery codes, **passkeys (WebAuthn)** as a passwordless factor,
  an admin **require-second-factor policy**, and **active-session / trusted-device**
  management (list and remotely revoke sessions).
- **Encryption canary** — refuses to boot if `ENCRYPTION_SECRET` no longer
  matches existing ciphertext, rather than silently returning unreadable PII.
- **Observability** — structured access logging (JSON in production) and an
  optional token-gated Prometheus scrape at `/metrics`.
- **Participant data export** — one-click "download everything" (PDF + JSON zip)
  for data-access requests.
- **Client portal** — give a participant their own read-only login to view their
  **finalised shift notes** (rendered, not raw Markdown) and **completed
  documents**. It is a completely separate sign-in from the staff app (its own
  accounts, session and section at `/portal`), scoped so a participant only ever
  sees their own records — never billing, drafts, the structured incident
  register, or anyone else's data. Admins grant, reset or revoke access from a
  **Portal access** tab on the participant's page. See the
  [client portal guide](docs/client-portal.md).

## Tech stack

| Layer      | Choice |
|------------|--------|
| Frontend   | Vue 3 (`<script setup>`), Vite, Tailwind, Pinia, Vue Router |
| Backend    | Express 5, better-sqlite3, Drizzle schema |
| Search/RAG | sqlite-vec (JS cosine fallback), `@xenova/transformers` local embeddings |
| AI         | Claude API (`@anthropic-ai/sdk`) — Haiku for cheap tasks, Sonnet for quality |
| Docs/API   | swagger-jsdoc + swagger-ui (`/api/docs`) |
| Runtime    | Node.js (ESM), Docker, port `3778` |

## Quick start (Docker Compose)

The recommended way to self-host CareLane is with the published image and the
provided [`docker-compose.yml`](docker-compose.yml). All you need is Docker with
the Compose plugin.

```bash
# 1. Get the deployment files (or just copy docker-compose.yml + .env.example)
git clone https://github.com/f3nici/carelane.git
cd carelane

# 2. Create your environment file from the template
cp .env.example .env

# 3. Edit .env and set, at minimum, strong unique values for:
#      SESSION_SECRET      — session signing key
#      ENCRYPTION_SECRET   — PII encryption key (BACK IT UP; cannot be rotated)
#      DEFAULT_PASSWORD    — seeded admin password (must not stay 'changeme')
#    Optionally set ANTHROPIC_API_KEY (AI features) and the Google/Square vars.

# 4. Start it (pulls the image; applies migrations + seeds on first boot)
docker compose up -d
```

Compose automatically reads the `.env` file sitting next to
`docker-compose.yml`, so the values you set there are passed into the container
— there's no need to copy `.env` inside the image. On startup the container
applies database migrations and seeds the admin user, default settings and
starter billing codes, so **no manual `migrate`/`seed` step is required.**

Open <http://localhost:8000> and log in with your `DEFAULT_USERNAME` /
`DEFAULT_PASSWORD` (default username `admin`).

- API documentation: <http://localhost:8000/api/docs>
- Health check: <http://localhost:8000/healthz>

The compose file publishes the app on host port **8000** (mapped to the
container's internal `3778`) and persists data in two bind-mounted directories
next to the compose file:

- `./data` — the SQLite database and scheduled backups
- `./uploads` — photos, documents and generated PDFs

Keep those directories (and your `ENCRYPTION_SECRET`) backed up — they hold all
your data. To update later, pull a newer image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

> The compose file pins `f3nici/carelane:latest`. For a reproducible deployment,
> pin a specific version tag instead (e.g. `image: f3nici/carelane:1.0.0`) — see
> [Releases](https://github.com/f3nici/carelane/releases).

## Running from source (development)

For local development (hot-reloading frontend, running tests, hacking on the
code) you can run it directly with Node instead of Docker:

```bash
npm install
cp .env.example .env     # set SESSION_SECRET, ENCRYPTION_SECRET, optionally ANTHROPIC_API_KEY
npm run dev              # Express :3778 + Vite :5173 (proxies /api)
```

Migrations and seeding run automatically when the server starts. Open
<http://localhost:5173> and log in with `DEFAULT_USERNAME` / `DEFAULT_PASSWORD`
(default `admin` / `changeme` — change these).

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

## Production from source

Docker Compose (see [Quick start](#quick-start-docker-compose)) is the
recommended way to run CareLane in production. To run it directly from source
instead, build the frontend and start the production server:

```bash
npm run build      # build the frontend to dist/
npm start          # serve dist/ + the API on port 3778
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
| `ANTHROPIC_API_KEY` | Claude API key; AI features are disabled without it. (The cheap/quality model IDs are set in-app under **Settings → AI**, not via env.) |
| `DEFAULT_USERNAME` / `DEFAULT_PASSWORD` | Seeded admin login. |
| `DB_PATH` | SQLite database file path. |
| `UPLOAD_PATH` / `MAX_UPLOAD_SIZE` | Upload directory and per-file size cap (bytes). |
| `EMBEDDING_MODEL` | transformers.js embedding model for RAG (default `Xenova/bge-small-en-v1.5`). Changing it requires `npm run reindex`. |
| `EMBEDDING_QUERY_PREFIX` | Optional query instruction prefix (auto-set for bge models). |
| `SEARCH_CANDIDATE_POOL` | Candidates pulled per arm (vector + BM25) before fusion/rerank. |
| `RERANK_ENABLED` / `RERANKER_MODEL` | Local cross-encoder reranker for the knowledge base. |
| `DEFAULT_PRICE_REGION` | NDIS price region for billing. |
| `BACKUP_ENABLED` / `BACKUP_PATH` / `BACKUP_RETENTION` / `BACKUP_TIME` / `BACKUP_STALE_HOURS` | Scheduled backup settings and the stale-backup startup-warning threshold. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | Brute-force throttle: failed-attempt ceiling and window. |
| `LOG_LEVEL` / `LOG_FORMAT` | Log verbosity (`debug`/`info`/`warn`/`error`) and format: `pretty` (readable, aligned lines — the docker-compose default) or `json` (one object per line, for log shippers; the default when `NODE_ENV=production` and `LOG_FORMAT` is unset). |
| `METRICS_ENABLED` / `METRICS_TOKEN` | Opt-in Prometheus scrape at `/metrics`; when a token is set it is required (Bearer or `?token=`). With no token set, token-less scrapes are served only to a private/loopback source address (a public source gets 401). See the [metrics setup guide](docs/metrics-setup.md). |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Pin the passkey relying-party id/origin. Auto-derived from the request when blank (correct for same-origin); set both behind a Host-rewriting proxy. |
| `PUBLIC_API_ENABLED` | Toggle for the public API surface. |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated). `https://localhost` (the Android app's WebView origin) is always allowed. |
| `SESSION_SAMESITE` | Session cookie SameSite: `lax` (default), `strict` or `none`. Set `none` to let the [CareLane Android app](https://github.com/f3nici/carelane-android) sign in — its WebView calls the server cross-origin, so the cookie must be sent cross-site. `none` forces the `Secure` flag, so the server must be served over HTTPS. Writes stay CSRF-protected either way. |
| `DEMO_MODE` / `DEMO_RESET_HOURS` | Public demo mode (default off). See [Public demo mode](#public-demo-mode) below. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Optional one-way Google Calendar sync. See the [Google Calendar setup guide](docs/google-calendar-setup.md). |
| `SQUARE_ACCESS_TOKEN` / `SQUARE_ENVIRONMENT` | Optional Square draft-invoicing. The location is auto-detected on the first "Test connection" in Settings. See the [Square invoicing setup guide](docs/square-invoicing-setup.md). |
| `NTFY_TOKEN` / `APP_BASE_URL` | Optional ntfy push notifications (topic/toggles/timings/request-timeout are all set in-app). Token is only for a protected/self-hosted server. See the [ntfy setup guide](docs/ntfy-notifications-setup.md). |

> ⚠️ **`ENCRYPTION_SECRET` cannot be rotated casually.** Once data is encrypted
> with it, changing it makes all existing PII unreadable. Back it up securely.

### Public demo mode

A live demo runs at **<https://carelane.feni.ci>**. Set `DEMO_MODE=true` to run
CareLane as a throwaway public showcase like it — useful for letting people try
the app without any real participant data.

- **Two shared logins** are created and advertised (and pre-filled) on the sign-in
  screen: a `demo` **admin** and a `demoworker` **support worker**, both with the
  password `demo`. Just press **Sign in**.
- **A client-portal login** (`aisha` / `demo`) is seeded for one example
  participant and advertised on the participant portal sign-in page
  (`/portal/login`), so you can also see the read-only participant view.
- **Rich example data** is seeded across every record type (participants, service
  agreements, shift notes, an incident report, goals + progress, medication and
  restrictive-practice logs, consent documents, a report and a roster), so every
  page has something to look at. The worker login is scoped to a subset of
  participants so you can see the difference between the two roles.
- **Everything resets** to this pristine state on a fixed cadence
  (`DEMO_RESET_HOURS`, default `6`) and once at boot, so visitors' changes are
  rolled back automatically.
- **Account-security and user-management writes are blocked** (changing a
  password / 2FA / passkey, or creating/deactivating logins) so no visitor can
  lock others out of the shared demo. These controls work normally on a real
  install.

> ⚠️ **Never enable `DEMO_MODE` on an install holding real data** — each reset
> **hard-deletes** all operational records. For the cleanest demo, also set
> `DEFAULT_USERNAME=demo` and `DEFAULT_PASSWORD=demo` so no separate
> `admin`/`changeme` login is seeded on first boot.

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
- **RAG pipeline** — PDF → per-page text → ~300-token chunks → local
  embeddings → `document_chunks.embedding` BLOB → hybrid search (sqlite-vec or
  JS cosine fallback + BM25 keyword, fused with Reciprocal Rank Fusion and
  reordered by a local cross-encoder reranker).
- **AI is draft-only** — Claude output is always a draft; finalisation
  (`finalised` / `signed_by_client` / `status=final`) is an explicit human
  action enforced in services. Whole PDFs and full participant records are never
  sent to the API; inputs are minimised (initials, bullets, top-k chunks).

See [`CLAUDE.md`](CLAUDE.md) for the full development guide, hard rules and code
style conventions.

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
sending any data. CareLane minimises what it sends (initials/short labels, top-k
excerpts — see [Data & privacy](#data--privacy)), with **one exception**: Square
invoicing sends the participant's name, email and phone, because an invoice needs
a real recipient (called out in the table below):

| Service | Used for | Required? | Terms / policies |
|---------|----------|-----------|------------------|
| **Anthropic (Claude API)** | AI drafting of agreements, reports, note cleanup and Q&A | Optional (no AI features without `ANTHROPIC_API_KEY`) | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) · [Usage Policy](https://www.anthropic.com/legal/aup) · [Privacy Policy](https://www.anthropic.com/legal/privacy) |
| **Hugging Face** | Downloading the local embedding & reranker models (`@xenova/transformers`) on first run | Effectively required for the knowledge base (models cached locally after download; inference runs on your own machine) | [Terms of Service](https://huggingface.co/terms-of-service) · [Privacy Policy](https://huggingface.co/privacy) |
| **Google Calendar** | One-way push of scheduled shifts to your calendar | Optional ([setup guide](docs/google-calendar-setup.md)) | [Google Terms of Service](https://policies.google.com/terms) · [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) · [Privacy Policy](https://policies.google.com/privacy) |
| **Square** | Creating draft invoices from completed shifts. **Sends the participant's name, email and phone** to Square as the invoice recipient (not minimised — invoicing needs a real addressee) | Optional ([setup guide](docs/square-invoicing-setup.md)) | [Developer Terms of Service](https://developer.squareup.com/us/en/terms) · [General Terms](https://squareup.com/au/en/legal/general/ua) · [Privacy Notice](https://squareup.com/au/en/legal/general/privacy) |
| **ntfy** | Push notifications for plan reviews, incident follow-ups, unbilled shifts and shift reminders | Optional ([setup guide](docs/ntfy-notifications-setup.md)); defaults to the public `ntfy.sh`, or point at your own server | [Terms / Privacy](https://ntfy.sh/) |
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
version tag you can pull (e.g. `git checkout 1.0.0`) and auto-generated notes.
See [`CHANGELOG.md`](CHANGELOG.md) for how releases are versioned and where to
find the full history.

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
