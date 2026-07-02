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

### 2.1 Two operating modes

The app has exactly two states, chosen by whether a server URL is configured:

- **Local mode (no URL set).** Fully standalone. Local encrypted DB, all logic
  on-device, no network anything. This is the whole product for a user who never
  self-hosts.
- **Paired mode (URL set).** *Not a web wrapper* — the phone keeps its full local
  database and keeps working offline. The configured URL is used only for a discrete,
  git-style **fetch → merge → push** sync (§5) guarded by a password-established device
  token over HTTPS (§8/§10). Setting/clearing the URL is a reversible operator action;
  clearing it drops back to local mode with data intact.

The crucial point: "closer to a web wrapper" is a spectrum, and this design sits firmly
at the **local-first** end. A thin web-wrapper (needs the server live to function) would
be easier to build but would break the "works fully standalone" promise. You cannot have
both; the branch-sync model is the resolution.

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
- `rev` — a per-row revision id bumped on every local write, and `base_rev` — the `rev`
  this row had at the **last successful sync** with the peer. The pair `(base_rev, rev)`
  is what enables a git-style **3-way merge**: it tells us whether a row changed locally,
  remotely, both (a conflict), or neither, relative to the last common baseline — with no
  reliance on wall clocks (see §5/§6). *(An earlier draft used Hybrid Logical Clocks for
  ordering; the branch model supersedes that and removes the clock-trust risk.)*
- `deleted_at` as the tombstone (already present on most tables) — deletes **replicate
  as a flag flip**, never as a row removal, which fits the "never hard-delete regulated
  records" hard rule perfectly.

Add these sync tables:

- `sync_change_log` — append-only journal of local writes since the last sync:
  `(seq, table, row_id, op, rev, node_id, changed_fields)`. The engine ships deltas from
  this rather than diffing whole tables.
- `sync_commits` — the branch lineage: each successful sync records a **sync commit**
  with a parent pointer to the previous common baseline. This DAG (not a clock) is what
  orders history and identifies the merge base.
- `sync_state` — per-peer cursor: the last sync-commit each side acknowledged.

Tables **missing** `updated_at` today that need it (or need to be declared
last-write-wins-by-parent): `agreement_line_items`, `client_billing_codes`,
`billing_codes`, `shift_photos`, `document_chunks`. `document_chunks` should **not**
sync at all (see §9). `activity_log` is special-cased in §8.

## 5. Sync protocol — a git-style branch/merge model

Paired mode syncs at **discrete, operator-visible sync points** ("Sync now", or on
reconnect), not continuously. Each side is a *branch*; a sync is a **fetch → merge →
push** against a known common baseline (the last `sync_commit`), exactly like `git pull`.
This is the model the operator asked for, and it is a better fit for regulated data than
continuous reconciliation because conflicts surface at a visible merge rather than being
resolved silently.

One sync round:

1. **Fetch**: `GET /api/v1/sync/changes?since=<last-commit>` returns every change the
   peer has recorded since the shared baseline commit, batched. (The server does the
   mirror when the phone serves its own changes.)
2. **Merge (3-way)**: for each incoming row, compare against the local row using
   `base_rev` as the common ancestor:
   - changed on **one** side only → fast-forward (apply, no conflict);
   - changed on **both** sides → a real conflict, resolved by §6;
   - unchanged → skip.
3. **Push**: `POST /api/v1/sync/changes` with local changes since the baseline.
   Idempotent by `(node_id, rev)` so retries are safe.
4. **Commit**: on success both sides write a new `sync_commit` whose parent is the old
   baseline, advance `sync_state`, and set every synced row's `base_rev = rev`. That new
   commit is the baseline for next time.

Properties:

- **Ordering comes from the commit DAG, not wall clocks.** A wrong device clock cannot
  corrupt merge order — history is ordered by sync-commit lineage and per-row `rev`.
- **Offline-tolerant**: the phone accumulates `sync_change_log` entries indefinitely and
  drains them at the next sync. This is the existing `offlineDrafts` idea generalised
  from "new notes only" to "every write, merged".
- **Field values travel as plaintext inside a TLS channel**, then get re-encrypted
  locally on the receiving node. We do **not** ship ciphertext blobs, because per-record
  random IVs mean the same plaintext encrypts differently on each node — merging must
  happen on decrypted field values, not opaque `enc:` strings. Since the server can read
  (shared key), this is consistent with the encryption decision.
- **Auth for sync**: a password-established, long-lived device token (see §8/§10) over
  HTTPS, distinct from the browser session cookie and independently revocable.

## 6. Conflict resolution

Because merge is **3-way against a baseline** (§5), most "conflicts" aren't: an edit on
only one side fast-forwards cleanly. A true conflict is only when the *same field* of the
*same row* changed on **both** sides since the last sync — rare for a single operator who
is usually on one device at a time.

When it does happen, the default is **field-level last-writer-wins**, but — unlike silent
LWW — the losing value is preserved in a `sync_conflicts` side table and surfaced in the
UI so nothing sensitive is lost without the operator seeing it.

Regulated data then layers rules that **override** the default. These encode the existing
hard rules as *merge invariants*:

| Situation | Rule |
|---|---|
| A record is `finalised` / `signed_by_client` / `status=final` | **Monotonic**: finalisation always wins; a concurrent non-final edit from the other branch can never un-finalise it. Genuine both-sides edits to a finalised record are rejected and surfaced for manual review, never silently applied. |
| Soft-delete vs. edit | If one branch deleted and the other edited, keep the row and surface the conflict (a restore beats a stale delete) rather than silently dropping the edit. |
| Incident-flagged shift note | Cannot be deleted on **either** node (existing rule) — a delete op for one is rejected at apply time. |
| Billing code | Deactivate, never delete — same as today; sync flips `active`, not existence. |
| Both-sides edit of an encrypted narrative (e.g. shift `body`) | Field-level LWW, **but** the losing version is kept in `sync_conflicts` and surfaced for the operator to reconcile — never silently discarded. |

Nothing here is a true CRDT; it's 3-way-merge-plus-domain-invariants, which is
appropriate for a single-operator tool where genuine concurrent edits are rare (you're
usually on one device at a time), and where an explicit, visible merge is preferable to
silent automatic reconciliation.

## 7. The audit-log problem (the sharpest edge)

`activity_log` is append-only and **tamper-evident**: each row's SHA-256 `hash` chains
off the previous row's (`prev_hash`), and any silent edit/reorder/delete breaks the
chain (`server/services/activityService.js`, verified via `GET /api/v1/audit/verify`).
This is a compliance feature.

A single linear chain **cannot** be extended by two independent writers — that's a
fundamental contradiction, not a bug to code around. The resolution falls out of the
branch model naturally: **a per-device audit chain simply *is* that device's branch.**

- **Per-device chains.** Namespace the chain by `node_id`: each node maintains and
  extends *its own* hash chain over the entries *it authored* (`prev_hash` within that
  node's chain only). A node can only cryptographically vouch for what it wrote — which
  is exactly the correct security property.
- **Sync** ships each node's chain entries; the receiver **verifies the incoming chain**
  before accepting it and stores it intact (audit entries are immutable, so they never
  "merge" — they interleave, exactly as branches do).
- **The global audit view** is the union of all per-node chains, ordered by the sync
  commit DAG. Verify becomes "every per-node chain is individually intact", and the UI
  shows which node authored each entry.

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
- **Phase 2 — One-way replication.** Change-log + revision/commit tracking +
  `sync/changes` endpoints; phone → server push only. Proves the pipe and gives
  browser-view + backups immediately.
- **Phase 3 — Two-way branch/merge.** Bidirectional fetch → 3-way merge → push against
  the baseline commit, the §6 invariants, `sync_conflicts` surfacing.
- **Phase 4 — Audit per-device chains** (§7) and **binary sync** (§9).
- **Phase 5 — Parity polish**: server-triggered PDF/AI/integrations from the app,
  pairing UX, device revocation, retire the PWA/service worker.

## 12. Risks & open questions

1. **Q-STACK** (§3): confirm React Native. Flutter roughly doubles domain-logic cost.
2. **Audit chain** (§7) is novel and compliance-sensitive — prototype and get comfort
   *before* committing to the rest.
3. ~~**Clock trust**~~ — *retired by the branch model (§5).* Ordering now comes from the
   sync-commit DAG + per-row `rev`, not wall clocks, so device clock drift cannot corrupt
   merge order. (`created_at`/`updated_at` are still displayed to the user, so a badly
   wrong clock is cosmetic, not corrupting.)
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
- The **git-style branch/merge model** (local mode ⇄ paired mode, discrete fetch →
  3-way merge → push) is the right sync design: it fits how a solo operator actually
  works, surfaces conflicts explicitly instead of silently, retires the clock-trust risk,
  and aligns 1:1 with the per-device audit chains.
- The native-rewrite decision is survivable **only** if we go React Native and extract a
  shared TypeScript core (§3); otherwise the domain logic forks permanently.
- Recommended sequence: **Phase 0 (extract core) → Phase 1 (standalone app)** delivers a
  genuinely useful offline app early and de-risks the hard sync work, which then lands
  incrementally in Phases 2–4.
