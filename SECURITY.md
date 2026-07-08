# Security Policy

CareLane stores sensitive health information (NDIS participant data). Security
reports are taken seriously and are very welcome.

## Supported versions

Security fixes are applied to the latest release and the `main` branch only. 
Older tagged versions are notback-patched — self-hosters should track the 
latest release.

| Version | Supported          |
|---------|--------------------|
| `main` / latest release | ✅ |
| Older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using either of the following:

1. **GitHub Security Advisories** (preferred) — open a private report at
   <https://github.com/f3nici/carelane/security/advisories/new>. This keeps the
   details confidential until a fix is available.
2. **Email** — <admin@fenici.com.au>. Use the subject line `CareLane security`.

Please include, where possible:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if you have one).
- The affected version / commit and your deployment setup.
- Any suggested remediation.

### What to expect

- **Acknowledgement** within 7 days.
- An assessment and, if confirmed, a remediation plan with a target timeline.
- Credit in the release notes / advisory if you would like it (let us know).

We ask that you give us a reasonable opportunity to release a fix before any
public disclosure (coordinated disclosure).

## Scope

CareLane is **self-hosted, single-operator** software — there is no
CareLane-operated production service to test against. Please only test against
your own deployment. In scope:

- The application code in this repository (auth, encryption, access control,
  upload handling, the public API surface, RAG/AI input handling, etc.).

Out of scope:

- The third-party services CareLane optionally integrates with (Anthropic,
  Google, Square, Hugging Face) — report those to the respective vendor.
- Findings that require an already-compromised host or operator credentials.
- Misconfiguration of a self-hosted instance (e.g. a weak `ENCRYPTION_SECRET`,
  exposing the database file, or running without TLS) — see the hardening notes
  in [`README.md`](README.md)

## Operator responsibilities

Because CareLane is self-hosted, the operator owns the runtime security posture:

- Keep `SESSION_SECRET` and `ENCRYPTION_SECRET` secret, strong, and backed up
  (`ENCRYPTION_SECRET` cannot be rotated without making existing data unreadable).
- Serve the app over TLS and restrict network access to trusted users.
- Secure the host, the SQLite database file, and the `uploads/` directory.
- Verify scheduled backups and keep dependencies up to date.
