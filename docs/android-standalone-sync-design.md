# CareLane — Standalone Android App with Optional Server Sync (Design)

Status: **Draft for discussion.** This is an architecture/feasibility design, not an
implementation plan yet. It records the decisions taken so far and the shape of the
work they imply, so the cost can be judged before any sync code is written.

## 1. What we're building

Today CareLane is **server-authoritative**: all business logic lives in
`server/services/*`, all data lives in one server-side SQLite database, and encryption
is keyed off a single server-held `ENCRYPTION_SECRET`. The Vue SPA is a thin REST
client that stores almost nothing locally (only the offline shift-note draft queue in
`src/composables/offlineDrafts.js`, deleted the instant it syncs).

The target is a **local-first** product:

- A **native Android app** is the primary client. It holds a full local database and
  runs the full app logic on-device. It works with **no server and no signal**.
- A **self-hosted server** is *optional*. When the operator pairs the app to their
  server it becomes a **co-equal sync peer** that also (a) serves the existing browser
  UI and (b) holds backups. Edits made in the browser and edits made on the phone both
  flow to the other side.
- The PWA/service-worker path is **retired** — the app replaces it.

### Decisions taken (these shape everything below)

| Axis | Decision | Consequence |
|---|---|---|
| App stack | **Native rewrite** | The Vue frontend and its component tree are not reused. See §3 for how we still salvage the *domain logic*. |
| Sync topology | **Two-way (multi-master)** — edit from phone *and* browser | Requires real conflict resolution, per-record sync metadata, and per-device audit chains. This is the hard version. |
| Encryption | **Shared key** — server can read the data | Server-side search, RAG, AI drafting and PDF export keep working in the browser. The phone and server share one `ENCRYPTION_SECRET`, provisioned at pairing. |

### Non-goals (for the first version)

- End-to-end encryption (server can read — that was the chosen trade-off).
- Multiple *separate* worker devices syncing to each other as independent writers
  beyond "one operator's phone + one server". The users table exists for future logins,
  but the sync design below is specified for **two nodes** (phone ⇄ server) and only
  *generalises* to N — it does not have to be proven at N on day one.
- On-device RAG / vector search / local LLM. These stay server-only (see §9).

## 2. Target architecture

```
┌─────────────────────────┐                 ┌──────────────────────────────┐
│  Android app (primary)  │                 │  Self-hosted server (optional)│
│                         │                 │                              │
│  Native UI (RN)         │                 │  Express (unchanged surface) │
│  ── shared domain core ─┼──── sync ───────┼─ shared domain core          │
│  on-device SQLite       │   (HTTPS, delta │  better-sqlite3 (as today)   │
│  local auth (biometric) │    change-log)  │  server-only extras:         │
│  works fully offline    │                 │   RAG · Claude · PDF · Square │
└─────────────────────────┘                 │   · Google Cal · ntfy · browser UI │
                                             └──────────────────────────────┘
```

The phone is never "the client of" the server. Both nodes own a full database; sync
reconciles them. The server is distinguished only by the extra capabilities it can run
(§9) and by hosting the browser experience.

## 3. Tech stack — and how we avoid writing the app twice

A native rewrite throws away the Vue *UI*. It does **not** have to throw away the
business logic — and it must not, because otherwise every billing calculation, every
validation rule, every "finalisation is a human action" guard would exist in two
languages and drift apart.

**Recommendation: React Native (not Flutter), specifically to preserve a shared core.**

React Native is JavaScript/TypeScript; the server is JavaScript. That lets us extract a
single **`@carelane/core`** TypeScript package that runs unmodified in **both** Node
(server) and React Native (phone):

- Zod validators (`server/utils/validators.js`) — already isomorphic.
- The service layer (`server/services/*`) — the actual domain logic (billing math,
  scheduling lifecycle, incident promotion, goal summaries, the finalisation guards).
- `cryptoService` (Node `crypto` → a small adapter over the phone's native crypto).
- The Drizzle schema (`server/db/schema.js`) as the shared table definitions.

To make the services portable they must stop importing `better-sqlite3` directly and
instead talk to a **repository interface**. Two implementations back it:

- Server: better-sqlite3 (exactly as today).
- Phone: an on-device SQLite driver — **`op-sqlite`** (fast, JSI, supports extensions)
  or `expo-sqlite`.

If we chose Flutter (Dart) instead, **zero** of the above is reusable — the entire
services layer would be reimplemented in Dart and kept in sync by hand forever. That is
why RN is the recommendation given the "native rewrite" decision: it is the only native
choice that keeps the domain logic single-sourced.

> Open question **Q-STACK**: confirm React Native over Flutter. If Flutter is preferred
> for UI reasons, we must budget for a permanent second implementation of all domain
> logic and its tests, and this doc's §5–§7 get materially harder.

## 4. Data-model changes for sync

Good news: most regulated tables already carry `created_at` / `updated_at` /
`deleted_at` (ISO text) and CareLane already does **soft delete only** — so tombstones
already exist in spirit. What's missing is enough metadata to order and merge concurrent
edits from two independent writers.

Add to every syncable table:

- `node_id` — which node last wrote this row (`phone-<uuid>` / `server-<uuid>`).
- `hlc` — a **Hybrid Logical Clock** stamp on last write (`<wall-ms>:<counter>:<node>`).
  Wall-clock timestamps alone are unsafe across two devices with drifting clocks; an HLC
  gives a total order that never goes backwards and breaks ties deterministically.
- `deleted_at` as the tombstone (already present on most tables) — deletes **replicate
  as a flag flip**, never as a row removal, which fits the "never hard-delete regulated
  records" hard rule perfectly.

Add one new table:

- `sync_change_log` — append-only journal of local writes not yet acknowledged by the
  peer: `(seq, table, row_id, op, hlc, node_id, payload)`. The sync engine ships deltas
  from this rather than diffing whole tables.
- `sync_state` — per-peer cursor: the last `hlc`/`seq` we've sent and received.

Tables **missing** `updated_at` today that need it (or need to be declared
last-write-wins-by-parent): `agreement_line_items`, `client_billing_codes`,
`billing_codes`, `shift_photos`, `document_chunks`. `document_chunks` should **not**
sync at all (see §9). `activity_log` is special-cased in §8.

## 5. Sync protocol

A change-log / delta-sync model (not full-table diffing, not a CRDT database):

1. **Pull**: `GET /api/v1/sync/changes?since=<hlc-cursor>` returns every change-log
   entry the server has past the caller's cursor, batched. Phone does the mirror over
   its own log when the server pulls.
2. **Apply**: each incoming change is merged per §6 and written locally; the local
   change-log is **not** re-appended for applied remote changes (no echo).
3. **Push**: `POST /api/v1/sync/changes` with the local entries past the server's
   cursor. Idempotent by `(node_id, seq)` so retries are safe.
4. **Advance cursors** in `sync_state` only after the peer acknowledges.

Properties:

- **Offline-tolerant**: the phone accumulates change-log entries indefinitely and drains
  them on next contact. This is the existing `offlineDrafts` idea generalised from
  "new notes only" to "every write".
- **Field values travel as plaintext inside a TLS channel**, then get re-encrypted
  locally on the receiving node. We do **not** ship ciphertext blobs, because per-record
  random IVs mean the same plaintext encrypts differently on each node — merging must
  happen on decrypted field values, not opaque `enc:` strings. Since the server can read
  (shared key), this is consistent with the encryption decision.
- **Auth for sync**: a long-lived device pairing token (see §10), distinct from the
  browser session cookie.

## 6. Conflict resolution

Default: **field-level Last-Write-Wins keyed by HLC**. Row-level LWW is too coarse — two
edits to different fields of the same client shouldn't clobber each other. So the
change-log records changed *fields*, and merge compares HLCs per field.

But regulated data needs rules that override raw LWW. These encode the existing hard
rules as *merge invariants*:

| Situation | Rule |
|---|---|
| A record is `finalised` / `signed_by_client` / `status=final` | **Monotonic**: finalisation wins over any older non-final edit; an edit with an older HLC can never un-finalise. Concurrent conflicting edits to a finalised record are rejected and surfaced for manual review, never silently applied. |
| Soft-delete vs. edit | Delete + edit merge to "deleted" only if the delete's HLC is newer; otherwise the row stays and the delete is dropped (matches restore semantics). |
| Incident-flagged shift note | Cannot be deleted on **either** node (existing rule) — a delete op for one is rejected at apply time. |
| Billing code | Deactivate, never delete — same as today; sync flips `active`, not existence. |
| Two-way edit collision on encrypted narrative (e.g. shift `body`) | LWW by HLC, **but** keep the losing version in a `sync_conflicts` side table so nothing sensitive is lost silently; surface it in the UI for the operator to reconcile. |

Nothing here is a true CRDT; it's LWW-plus-domain-invariants, which is appropriate for a
single-operator tool where genuine concurrent edits are rare (you're usually on one
device at a time).

## 7. The audit-log problem (the sharpest edge)

`activity_log` is append-only and **tamper-evident**: each row's SHA-256 `hash` chains
off the previous row's (`prev_hash`), and any silent edit/reorder/delete breaks the
chain (`server/services/activityService.js`, verified via `GET /api/v1/audit/verify`).
This is a compliance feature.

A single linear chain **cannot** be extended by two independent writers — that's a
fundamental contradiction, not a bug to code around. The resolution:

- **Per-device chains.** Namespace the chain by `node_id`: each node maintains and
  extends *its own* hash chain over the entries *it authored* (`prev_hash` within that
  node's chain only). A node can only cryptographically vouch for what it wrote — which
  is exactly the correct security property.
- **Sync** ships each node's chain entries; the receiver **verifies the incoming chain**
  before accepting it and stores it intact (audit entries are immutable, so they never
  "merge" — they interleave).
- **The global audit view** is the union of all per-node chains, ordered by HLC. Verify
  becomes "every per-node chain is individually intact", and the UI shows which node
  authored each entry.

This changes the audit schema and `activityService`, and the migration must re-seal
existing rows under the server's `node_id`. It is the single most careful piece of the
whole project and should be prototyped first.

## 8. Encryption & key model

Shared-key was chosen, so both nodes hold the **same `ENCRYPTION_SECRET`**:

- Field values are decrypted → merged → re-encrypted per §5, so ciphertext portability
  doesn't matter; the key matching does.
- The **blind index** (`ndis_number_hash`, HMAC) also derives from the shared secret, so
  NDIS-number search works identically on both nodes.
- **On the phone**, the secret is stored in the Android Keystore (hardware-backed),
  never in plain app storage. The local SQLite file itself should be encrypted at rest
  (SQLCipher via `op-sqlite`, or full-DB encryption) since the phone now holds all PII.
- **Key provisioning happens at pairing** (§10). The tricky case is an *existing* server
  (which already has a fixed, unrotatable secret): the phone must **import the server's
  secret** during pairing, not generate its own. For a brand-new setup, the phone
  generates the secret and the server adopts it. The startup **encryption canary**
  (`settings.enc_canary`) must be taught to accept a provisioned secret.

## 9. Feature parity matrix — what runs where

The phone runs the full CRUD + business logic offline. Some capabilities are inherently
server-side and become **"available when synced/paired"**, degrading gracefully offline:

| Capability | Phone (offline) | Server (browser / when paired) |
|---|---|---|
| Clients, agreements, shifts, goals, incidents, meds, restrictive practices — full CRUD | ✅ | ✅ |
| Roster / scheduling, clock in-out | ✅ | ✅ |
| Recurrence materialisation cron | ⚠️ on-device scheduler or done at sync | ✅ (existing cron) |
| Audit log (own chain) | ✅ writes locally | ✅ merges + verifies |
| PDF export (incidents, reports) | Option A: on-device PDF lib; Option B: request from server when paired | ✅ (pdfkit) |
| RAG / knowledge search / embeddings / rerank | ❌ (models are hundreds of MB; needs sqlite-vec) — **server-only** | ✅ |
| AI drafting (Claude) | ❌ needs API key — should not ship in app; run via server | ✅ |
| Square invoicing, Google Calendar, ntfy | ❌ server-only integrations | ✅ (triggered server-side) |
| Photo/document uploads | ✅ stored locally, synced as binaries | ✅ |

**Binary sync** (photos in `shift_photos`, files in `client_documents`, `uploads/`) is
its own sub-protocol: content-addressed by hash, transferred out-of-band from the
field-value change-log, resumable. Budget for it explicitly.

RAG/AI being server-only is fine and honest: offline you capture and manage everything;
drafting and knowledge-base Q&A light up when you're back on your paired server.

## 10. Auth & pairing

- **Standalone auth**: the phone has its own local login — biometric / device PIN backed
  by Keystore, falling back to the bcrypt password already in the schema. No server
  required. Server sessions, TOTP and passkeys remain the browser's concern.
- **Pairing flow** (one-time): operator opens the server's browser UI → Settings →
  "Pair a device", which shows a QR / short code. The phone scans it, and over an
  authenticated channel the two exchange: the shared `ENCRYPTION_SECRET`, a long-lived
  **device sync token**, the server URL, and initial `sync_state`. This is where the
  "put your link in settings" idea from the original request actually lives.
- The sync token is a `webauthn_credentials`-style first-class device record so it can be
  listed and **revoked** from the existing Sessions/Devices UI.

## 11. Phased delivery

This is a multi-month effort. Phasing keeps the existing product working throughout.

- **Phase 0 — Extract `@carelane/core`.** Refactor `server/services/*` off direct
  `better-sqlite3` access onto a repository interface; move schema + validators + crypto
  into the shared package. *Server behaviour unchanged; fully shippable on its own.* This
  de-risks everything and is valuable even if the app slipped.
- **Phase 1 — Standalone app, no sync.** RN skeleton, on-device encrypted SQLite, port
  migrations, wire `@carelane/core` to the on-device repo, local auth. Deliverable: a
  fully working offline app with **no** server involvement.
- **Phase 2 — One-way replication.** Change-log + HLC + `sync/changes` endpoints; phone
  → server push only. Proves the pipe and gives browser-view + backups immediately.
- **Phase 3 — Two-way + conflict resolution.** Bidirectional pull/apply, field-level LWW
  + the §6 invariants, `sync_conflicts` surfacing.
- **Phase 4 — Audit per-device chains** (§7) and **binary sync** (§9).
- **Phase 5 — Parity polish**: server-triggered PDF/AI/integrations from the app,
  pairing UX, device revocation, retire the PWA/service worker.

## 12. Risks & open questions

1. **Q-STACK** (§3): confirm React Native. Flutter roughly doubles domain-logic cost.
2. **Audit chain** (§7) is novel and compliance-sensitive — prototype and get comfort
   *before* committing to the rest.
3. **Clock trust**: HLC mitigates drift but a wildly wrong phone clock still needs
   guarding; consider anchoring HLC wall-time to the server at pairing/sync.
4. **The phone now holds all PII.** Lost/stolen device is a new threat surface that the
   server-only model didn't have — mandates at-rest DB encryption + biometric gate +
   remote revoke, and possibly a remote-wipe-on-revoke.
5. **Existing-server key import** (§8): the unrotatable `ENCRYPTION_SECRET` + canary make
   adopting the phone to an *existing* deployment fiddly; design the import path early.
6. **Two-way editing of the same finalised/regulated record** is where silent data loss
   could occur — the §6 invariants and `sync_conflicts` table are load-bearing; they
   need tests, not just prose.
7. **Maintenance surface**: this turns one deployable into three (core, server, app) plus
   an app-store release cadence. Real ongoing cost, not just build cost.

## 13. Bottom line

- The Android *shell* was never the hard part. **Two-way sync over regulated,
  encrypted, audit-chained data is** — items §6, §7 and §8 are the real work.
- The native-rewrite decision is survivable **only** if we go React Native and extract a
  shared TypeScript core (§3); otherwise the domain logic forks permanently.
- Recommended sequence: **Phase 0 (extract core) → Phase 1 (standalone app)** delivers a
  genuinely useful offline app early and de-risks the hard sync work, which then lands
  incrementally in Phases 2–4.
</content>
</invoke>
