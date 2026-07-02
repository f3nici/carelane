# Prompt B — run this in the new `carelane-app` repo

> Paste everything below the line into Claude Code, working in a fresh
> `carelane-app` repository. You will have the sibling `carelane` repo checked
> out locally so Claude Code can read the shared core and the design doc.
> **Run Prompt A in `carelane` first** — this app depends on `@carelane/core`.

---

You are building **`carelane-app`**, the native Android app for CareLane. The
sibling `carelane` repo is available locally — read its
`docs/android-standalone-sync-design.md`, its `CLAUDE.md`, and
`packages/core/README.md` before starting.

## Goal

A **React Native** app that runs CareLane **fully standalone on an Android
phone** — its own encrypted on-device database, all domain logic on-device, no
server and no network required. It reuses the shared `@carelane/core` package
(schema + domain logic + crypto) so business rules are single-sourced with the
server.

**Scope for v1: standalone only.** Two-way sync with a self-hosted server is a
LATER phase — do not build it now. But leave the seams for it (see "Design for
later sync").

## Stack

- **Expo** (bare/prebuild workflow) + **TypeScript**. Use a custom dev client
  (not Expo Go) because we need native SQLite with encryption.
- **Database:** `@op-engineering/op-sqlite` with **SQLCipher** encryption, driven
  through **`drizzle-orm/op-sqlite`** using `@carelane/core`'s Drizzle schema.
- **Key storage:** the SQLCipher key / `ENCRYPTION_SECRET` lives in the Android
  Keystore via `react-native-keychain` (or `expo-secure-store`), gated behind a
  biometric / device-credential prompt. Never store it in plain app storage.
- **Crypto for the core:** inject `react-native-quick-crypto` as the core's
  `CryptoProvider` (node-`crypto`-compatible), so `@carelane/core`'s
  encryption/blind-index/HMAC produce byte-identical output to the server.
- **Navigation:** Expo Router (file-based).
- **Data/reactivity:** TanStack Query over a thin data layer that calls
  `@carelane/core` services; keep it light.

## Consuming `@carelane/core`

The core lives in the `carelane` repo. Wire it as a **git submodule** so both
local dev and CI have it, with no package registry to set up yet:
- Add `carelane` as a submodule (e.g. at `vendor/carelane`).
- Depend on the built core: `"@carelane/core": "file:vendor/carelane/packages/core"`.
- Configure Metro `watchFolders` + resolver so it resolves the package.
- CI and local install run the core's build (`npm run build:core` in the
  submodule) before bundling.
- Add a `README` note that this can later be swapped for a published
  GitHub Packages dependency once sync work begins.

## App scope (v1)

Build the on-device experience for the in-core record types:
- **First-run setup:** generate the DB encryption key, store it in Keystore
  behind biometrics, create + migrate the encrypted SQLite DB using the core's
  schema/migrations, seed default settings + starter billing codes (mirror the
  server's seed for the in-core tables).
- **Local auth:** biometric / device-credential unlock on launch, with a
  bcrypt password fallback (via the core's `accountService`). This is device-local
  auth — no server sessions/TOTP/passkeys.
- **Screens (full CRUD, all offline):** Dashboard (the "needs attention" counts
  the core can compute), Clients + client detail (PII, documents metadata, goals,
  medications, restrictive practices), Roster/scheduling with clock in/out →
  shift note, Shift notes, Incidents (create/lifecycle), Agreements, Billing
  codes, Deleted Items (restore), Audit log view (the on-device chain).
- **Uploads/photos:** store files in app-private encrypted storage; keep the
  metadata rows the core expects. Serve them only in-app.

## Explicitly OUT of scope for v1 (stub or hide, don't build)
- Server sync of any kind.
- Server-only capabilities: RAG / knowledge search, AI drafting (Claude), PDF
  export, Square, Google Calendar, ntfy. Hide their UI or show a "available when
  paired with a server (coming soon)" placeholder.

## Design for later sync (seams only, no implementation)
- Add a **Settings → Server** screen with a "Server URL" field that is present
  but inert (saved to settings, used by nothing yet). This is where pairing will
  live later.
- Keep all writes going through a single data-access layer so a change-log /
  revision-tracking layer can be slotted underneath later without touching
  screens. Do not add revision columns or change-log tables now.

## GitHub Actions — build the APK
Add a workflow (`.github/workflows/android.yml`) that:
- Triggers on push to `main`, on tags (`v*`), and `workflow_dispatch`.
- Checks out with submodules (`submodules: recursive`), sets up Node + JDK 17,
  installs deps, builds `@carelane/core`, runs `expo prebuild --platform android`,
  then `./gradlew assembleRelease` (fall back to `assembleDebug` when no signing
  secrets are configured).
- Uploads the resulting `.apk` as a build artifact.
- **Signing:** default to a debug-signed APK. Add a guarded release-signing path
  that activates only when `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` secrets are present — decode the
  keystore, wire it into Gradle signing config. Document the secret names in the
  README; never commit a keystore.

## Constraints & done criteria
- Match the CareLane style spirit (clean, typed, small modules). Preserve the
  core's encryption wire-format exactly — data written on-device must be
  byte-compatible with what the server would write (this matters for later sync).
- The app must launch, create its encrypted DB, and let you create a client,
  schedule + clock a shift, write a note, and log an incident — all with airplane
  mode on.
- The GitHub Actions workflow produces a downloadable APK artifact on a manual
  run.
- Write a README covering: prerequisites, the submodule setup, building the core,
  running the dev client, and the CI signing secrets.
- Work on a feature branch with scoped commits; do not push to `main`.
</content>
