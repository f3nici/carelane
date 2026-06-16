# Changelog

All notable changes to CareLane are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Housekeeping for self-hosters: `LICENSE` (MIT with the Commons Clause —
  source-available; free to use, modify, fork and self-host, including for your
  own paid practice, but no reselling or hosting it as a service for others),
  `SECURITY.md` disclosure policy, this changelog, and Dependabot configuration
  for npm and GitHub Actions updates.
- Documented the terms of service for every optional outbound integration
  (Anthropic, Google, Square, Hugging Face) in the README.

## [0.1.0] - 2026-06-16

Initial development snapshot. CareLane is a self-hosted, single-operator
management tool for an independent NDIS support worker. All participant data is
treated as sensitive health information and encrypted at rest.

### Added
- **Participants/clients** — encrypted PII, NDIS number searchable via a
  blind-index HMAC, structured goal tracking with dated progress notes, and a
  consent/document store with expiry tracking. Soft-delete only.
- **Service agreements** — questionnaire → AI-drafted agreement → human review →
  explicit finalisation / client sign-off, with expiry tracking.
- **Shift notes** — encrypted note body and incident details, photo attachments,
  incident flagging, and quarter-hour duration rounding.
- **Scheduling/roster** — one-off and recurring scheduled shifts with a
  clock-in/clock-out lifecycle and rolling materialisation of recurrences.
- **Billing codes** — importable NDIS price-guide codes; per-participant custom
  rates; deactivate (never delete).
- **Reports** — AI-assisted progress/summary reports rendered to PDF.
- **Knowledge base (RAG)** — upload PDFs/DOCX, hybrid (vector + BM25) search with
  local embeddings and a cross-encoder reranker, grounded Q&A, per-document
  embedding-model tracking, and auth-gated original-file downloads.
- **Activity log** — append-only, PII-redacted, tamper-evident hash-chained
  audit trail with a filterable viewer and `GET /audit/verify`.
- **Deleted items** — list and restore soft-deleted records (clients,
  agreements, shifts, reports, templates, scheduled shifts, documents, goals).
- **Backups** — scheduled SQLite backups with retention, integrity verification,
  a stale-backup startup warning, and an offline restore CLI.
- **Login hardening** — brute-force rate limiting, optional TOTP 2FA with
  recovery codes, and passwordless passkey (WebAuthn) login.
- **Encryption canary** — refuses to boot if `ENCRYPTION_SECRET` no longer
  matches existing ciphertext.
- **Participant data export** — one-click PDF + JSON zip for data-access requests.
- **Optional integrations** — one-way Google Calendar sync (OAuth2, encrypted
  refresh token) and Square draft-invoice creation from completed shifts.

[Unreleased]: https://github.com/f3nici/carelane/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/f3nici/carelane/releases/tag/v0.1.0
