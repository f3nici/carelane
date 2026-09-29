# Client portal

The client portal gives a participant (or their nominee) their own **read-only**
login to view their information in CareLane — specifically the **progress note**
(and any photos) from their **finalised shift notes**, plus their **completed
documents**. It is designed for transparency: the participant sees the narrative
that was recorded about the support they received, rendered in plain language,
without needing to contact you for a copy.

It is a completely separate surface from the staff app. It has its own accounts,
its own sign-in page, its own session, and its own section of the interface —
nothing about it can reach the staff app, and a staff login cannot reach it.

## What a participant can see

When signed in to the portal a participant sees only **their own** records:

- **Shift notes** — every note about them that a worker has **finalised**
  (drafts, archived and deleted notes are never shown). For each note the portal
  shows only the **progress note** — the narrative, rendered from Markdown into
  formatted text — alongside the date, time and location, plus any **photos**
  attached to the note. The other structured fields (support provided, how the
  shift went) are not surfaced.
- **Documents** — their completed documents (consent forms, plans, signed
  paperwork, …), which they can download.

## What a participant can **not** see

The portal deliberately exposes a narrow slice of a note. It never shows:

- **billing** information (rates, whether a shift was billed/invoiced);
- the structured note fields beyond the progress note — **support provided**,
  **how the shift went**, and the **incident narrative/flag** are not surfaced;
- the **structured incident register** — the separate NDIS incident report
  (reportable categories, reported-to-Commission status, contributing factors,
  witnesses, notified parties and internal follow-up) stays staff-only;
- **draft** notes — only finalised records the worker has completed;
- **any other participant's** data — every read is scoped to the signed-in
  participant.

## Granting access (admin)

Portal access is managed by an **admin** from the participant's page:

1. Open **Clients → the participant → Portal access** tab.
2. Enter a **username** and an initial **password** (at least 10 characters) and
   press **Create portal login**.
3. Share the credentials with the participant securely (not by unencrypted email
   where you can avoid it).

From the same tab you can later:

- **rename** the login or **enable/disable** access with the *Access enabled*
  toggle (disabling immediately signs the participant out and blocks new logins);
- **reset the password** (which also ends any active portal session);
- **remove access** entirely.

Only an admin can manage portal accounts — support workers cannot see or change
them. One portal login exists per participant.

## Signing in (participant)

The portal sign-in page is at **`/portal/login`** on your CareLane host (there is
also a link to it from the bottom of the staff sign-in page). After signing in
the participant lands on their **Shift notes**, with a **Documents** tab
alongside, and a **Sign out** button.

## How it stays isolated (for operators / auditors)

- Portal accounts live in their own table (`client_portal_accounts`), entirely
  separate from the staff `users` table. A portal session stores only the
  participant id, never a staff user id, so a portal credential can never satisfy
  the staff authentication middleware — and vice versa.
- Every portal API route is scoped to the signed-in participant's `client_id`, so
  a participant can only ever read their own notes and documents.
- The passwords are bcrypt-hashed (cost 12), exactly like staff logins. Sign-in
  is brute-force throttled and survives restarts.
- Portal sign-ins are written to the append-only audit trail
  (`client` entity, `portal_login` action).
- Deactivating a participant, soft-deleting their record, or disabling the portal
  account all immediately revoke portal access.

## In the public demo

When `DEMO_MODE=true`, a portal login is seeded for one example participant —
username **`aisha`**, password **`demo`** — and advertised (and pre-filled) on
the portal sign-in page, so the participant view can be explored alongside the
admin and support-worker views. Portal-account management writes are disabled in
the demo, like the other account-security controls.
