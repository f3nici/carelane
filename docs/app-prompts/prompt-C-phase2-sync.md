# Phase 2 — Server sync (branch/merge). Cross-repo.

> This phase spans BOTH repos and must be done in order. It implements the
> git-style branch/merge sync from `docs/android-standalone-sync-design.md`
> (§4–§6, §8, §10). Do it only after Prompts A and B are done and the standalone
> app runs.
>
> - **Prompt C** runs in `carelane` (server + `@carelane/core`) — it defines the
>   sync protocol, the change-tracking write path, and the server endpoints.
> - **Prompt D** runs in `carelane-app` — it consumes the updated core, adds
>   pairing + the sync client + a conflicts UI.
>
> The wire protocol types live in `@carelane/core` and are imported by both
> sides, so there is a single source of truth for the contract.
>
> **Out of scope for this phase (a later Phase 4 prompt):** audit-log merge /
> per-device hash chains (§7), binary/upload (photo/file) sync (§9), and
> server-triggered PDF/AI/integrations from the app. Sync the structured
> relational data only; each node keeps its own local `activity_log` for now.
> The design is specified for **two nodes** (one phone + one server); do not try
> to prove N>2.

---

## Prompt C — run in the `carelane` repo

You are in `carelane`. Read `docs/android-standalone-sync-design.md` (§4–§6, §8,
§10) and `packages/core/README.md` before starting. Phases A and B are done:
`@carelane/core` exists with an injected `{ db, sqlite, crypto, now }` context and
all writes go through one data-access seam.

### Goal
Add the git-style branch/merge sync from the design doc: per-row revision
tracking, a change-log, a 3-way merge engine, and server endpoints + device
pairing. Ordering comes from a **sync-commit DAG + per-row `rev`**, never wall
clocks. Encryption stays **shared-key** (server can read). This must be
host-agnostic: put the tracking + merge engine in `@carelane/core` so the app
reuses it byte-for-byte.

### Step 1 — Identity, revisions, change-log (in `@carelane/core`)
- **Node identity:** each host has a stable `node_id` (`server-<uuid>` /
  `phone-<uuid>`), created once and stored in `settings`.
- **Per-row sync metadata** on every syncable table (schema in core, migration
  for the server): `node_id` (last writer), `rev` (bumped every local write),
  `base_rev` (the `rev` at last successful sync — the merge base). `deleted_at`
  stays the tombstone; deletes replicate as a flag flip, never a row removal.
- **`sync_change_log`** — append-only: `(seq, table, row_id, op, rev, node_id,
  changed_fields)`. The core's data-access seam appends to this on every write,
  so both hosts get tracking for free.
- **`sync_commits`** — the branch DAG: each successful sync writes a commit with
  a parent pointer to the previous baseline. **`sync_state`** — per-peer cursor.
- Tables still missing `updated_at`/identity from the design doc's §4 note get it
  now, EXCEPT `document_chunks` (never syncs) and `activity_log` (deferred).

### Step 2 — Merge engine (in `@carelane/core`, host-agnostic)
Pure functions over the injected context, no network:
- `collectChangesSince(baselineCommit)` → the local delta.
- `merge(remoteChanges)` → **3-way** against `base_rev`: changed on one side =
  fast-forward; changed on both = conflict; unchanged = skip.
- **Merge invariants** (encode the existing hard rules; test each):
  - `finalised`/`signed_by_client`/`status=final` is **monotonic** — never
    un-finalised by an older-branch edit; genuine both-sides edits to a finalised
    record are rejected → `sync_conflicts`, never silently applied.
  - Incident-flagged shift notes cannot be deleted on either side — reject the op.
  - Billing codes deactivate, never delete — sync flips `active`.
  - Delete-vs-edit → keep the row, surface the conflict (restore beats stale
    delete).
  - Both-sides edit of an encrypted narrative → field-level last-writer-wins, but
    keep the losing value in **`sync_conflicts`** for the operator; never discard.
- `commit()` — write the new `sync_commit` (parent = old baseline), advance
  `sync_state`, set `base_rev = rev` on synced rows.
- **Field values are compared/merged as PLAINTEXT** inside the engine (decrypt →
  merge → re-encrypt locally). Do not diff `enc:` blobs — per-record IVs make
  identical plaintext encrypt differently.
- Export the **wire types** (change record, delta batch, commit handshake,
  conflict) from core so the app imports the identical contract.

### Step 3 — Server endpoints + pairing (in `server/`)
- **Device tokens:** a new first-class device record (model it like
  `webauthn_credentials` so it lists + revokes in the existing Sessions/Devices
  UI). Sync calls authenticate with a long-lived device token over HTTPS, distinct
  from the browser session cookie.
- **Pairing (admin-initiated in the browser):**
  `POST /api/v1/auth/pairing` issues a short-lived, single-use pairing code.
  A redeem endpoint exchanges `{code}` for a device token AND provisions the
  shared `ENCRYPTION_SECRET` to the caller (one-time, code-authenticated, TLS
  only) so the phone ends up with the server's key (server-can-read model). The
  encryption canary logic must accept a provisioned secret. Guard tightly:
  short TTL, single use, rate-limited, admin-only issuance.
- **Sync protocol:**
  - `GET /api/v1/sync/changes?since=<commit>` → the delta since the shared
    baseline, batched/resumable.
  - `POST /api/v1/sync/changes` → apply a pushed delta via the core merge engine;
    **idempotent** by `(node_id, rev)` so retries are safe.
  - A handshake to agree the baseline commit and advance `sync_state`.
- All sync routes go behind CSRF-appropriate protections for a token client (not
  cookie/CSRF); follow the repo's existing envelope + Zod validation patterns.

### Step 4 — Deliver incrementally
1. Land Step 1 + 2 first (tracking + engine, unit-tested, server behaviour
   otherwise unchanged, existing tests green).
2. Then endpoints + pairing (Step 3).
3. **One-way replication checkpoint:** enable phone→server push only end-to-end
   (design Phase 2) before wiring the return path — this alone gives browser
   viewing + backups.
4. Then full two-way pull + merge (design Phase 3).

### Tests
- Merge-engine unit tests for every invariant above.
- A two-node simulation: two in-memory core instances diverge, then merge, and
  converge; verify idempotent replay and conflict capture.
- Existing Vitest suite stays green; canary + (local) audit verify still pass.

### Constraints
Repo style (no-semi, single-quote, 2-space, JSDoc on core + handlers). No E2E
crypto (shared key). Feature branch, scoped commits, don't push to `main`.

---

## Prompt D — run in the `carelane-app` repo

You are in `carelane-app`. Prompt C is merged in `carelane`. Read the updated
`packages/core/README.md` and `docs/android-standalone-sync-design.md` (§5, §8,
§10) in the sibling repo first.

### Goal
Turn the inert "Server URL" seam into a working pairing + branch/merge sync
client, reusing `@carelane/core`'s tracking + merge engine and wire types. Still
two nodes only (this phone + one server).

### Tasks
1. **Bump the core submodule** to the sync-capable version and rebuild it. The
   change-tracking data-access seam from Prompt B now activates (writes bump
   `rev` and append to `sync_change_log`). Screens should need no changes.
2. **Pairing flow:** Settings → Server. Enter the server URL + the pairing code
   shown in the server's browser UI; redeem it to receive a device token +
   the shared `ENCRYPTION_SECRET`. Store the device token in the Android Keystore
   (behind biometrics).
3. **Key re-keying (critical — do not skip):** if the app already holds local
   data encrypted under an app-generated key, adopting the server's shared
   `ENCRYPTION_SECRET` means every encrypted column AND every blind-index HMAC
   was computed under the wrong key. On first pairing, run a one-time migration
   that decrypts each encrypted field with the old key and re-encrypts with the
   shared key, and recomputes blind indexes (e.g. `ndis_number_hash`). Do this
   transactionally; verify with the canary before committing. If it cannot be
   done safely, block pairing with a clear error rather than corrupting data.
4. **Sync client:** a "Sync now" action plus auto-sync on reconnect. Run the
   core engine's **fetch → 3-way merge → push** against the baseline commit using
   the shared wire types; authenticate with the device token; handle "token
   revoked" by prompting re-pair. Show sync status + last-synced time.
5. **Conflicts UI:** a screen listing `sync_conflicts` (both-sides edits,
   rejected finalised-record edits, delete-vs-edit) so the operator can review
   and resolve; nothing sensitive is ever dropped silently.
6. **Unpair:** clearing the server URL revokes the local token and drops back to
   local mode with data intact (data stays encrypted under the now-shared key).

### Out of scope (Phase 4)
Audit-log sync, binary/photo sync, and server-triggered PDF/AI/integrations —
keep those hidden/stubbed as in v1.

### Done when
- From a fresh browser instance you can pair the phone, create/edit records on
  both sides, sync, and see them converge — with conflicts surfaced, not lost.
- Encrypted fields written on-device are byte-compatible with the server's
  (verified by the server reading them after a push).
- Airplane-mode standalone use is unaffected; sync only runs when paired + online.
- README updated: pairing, re-keying behaviour, sync + conflicts UX. Feature
  branch, scoped commits, don't push to `main`.
</content>
