# Google Calendar setup

CareLane can mirror your scheduled shifts into a Google Calendar (one-way push).
Events carry only a short participant label (preferred name / initials) and the
location — **never** plan notes or health information.

This guide walks through the Google Cloud Console from scratch. The console can
be confusing, so follow the steps in order — most setup problems come from
**skipping the "Enable the API" step** or a **redirect URI that doesn't match
exactly**.

> You need: a Google account, and the public URL CareLane runs on
> (e.g. `https://carelane.example.com`). Replace that placeholder with your real
> domain throughout.

---

## Overview

You will:

1. Create a Google Cloud project.
2. **Enable the Google Calendar API** (the step people miss).
3. Configure the OAuth consent screen.
4. Create an OAuth **Web application** client → get a Client ID + Client Secret.
5. Put those into CareLane's environment.
6. Connect from **Settings → Google Calendar** and verify with **Test connection**.

---

## 1. Create a project

1. Go to <https://console.cloud.google.com/>.
2. In the top bar, click the project dropdown → **New Project**.
3. Name it (e.g. `CareLane`) → **Create**.
4. Make sure this new project is selected in the top bar before continuing — every
   later step must happen **inside the same project**.

## 2. Enable the Google Calendar API

This is the most common cause of a `403` when syncing.

1. Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   (with your project selected).
2. Click **Enable**.
3. Wait ~1 minute for it to propagate.

You can confirm later under **APIs & Services → Enabled APIs & services** — the
*Google Calendar API* should be listed.

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. User type: **External** → **Create**.
3. Fill the required fields:
   - **App name**: `CareLane`
   - **User support email**: your email
   - **Developer contact email**: your email
   - You can leave logo/links blank.
4. **Scopes** step → **Add or remove scopes** → search for and tick:
   ```
   https://www.googleapis.com/auth/calendar.events
   ```
   (This is the only scope CareLane needs — read/write events. It does **not**
   request access to read your other calendars.) → **Update** → **Save and continue**.
5. **Test users** step → **Add users** → add the Google account whose calendar you
   want to sync to. **This matters:** while the app is in *Testing* mode, only
   listed test users can connect. → **Save and continue**.

> You do **not** need to publish the app or go through Google verification for a
> single-operator self-hosted setup. Leaving it in *Testing* with yourself as a
> test user is fine. (Test-mode refresh tokens can expire after 7 days of being
> unused — if sync silently stops, just reconnect, or publish the app.)

## 4. Create the OAuth client credentials

1. Go to **APIs & Services → Credentials**.
2. **+ Create credentials → OAuth client ID**.
3. **Application type: Web application**.
4. **Name**: `CareLane`.
5. **Authorised redirect URIs → + Add URI** — add this **exactly**, with your real
   domain:
   ```
   https://carelane.example.com/api/v1/schedule/google/callback
   ```
   - It must match character-for-character (scheme, domain, path, no trailing slash).
   - The path is always `/api/v1/schedule/google/callback`.
   - **Authorised JavaScript origins** are **not** required — CareLane does the
     token exchange server-side. You can leave that section empty.
6. **Create**.
7. Copy the **Client ID** and **Client secret** shown in the dialog. The secret
   can't be viewed again later, so save it somewhere safe (you can always mint a
   new one with **Add secret**).

## 5. Configure CareLane's environment

Set these three variables in your environment:

```bash
GOOGLE_CLIENT_ID=1234567890-abc...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://carelane.example.com/api/v1/schedule/google/callback
```

`GOOGLE_REDIRECT_URI` **must be identical** to the redirect URI you entered in
step 4.

### Docker Compose

CareLane reads these from the container's environment — it does **not** auto-load
a `.env` file inside the app. The provided `docker-compose.yml` already forwards
the three variables:

```yaml
    environment:
      # ...
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      GOOGLE_REDIRECT_URI: ${GOOGLE_REDIRECT_URI:-}
```

Put the values in the `.env` file next to `docker-compose.yml`, then **recreate**
the container so it picks up the new environment (a plain restart is not enough):

```bash
docker compose up -d
docker compose exec carelane printenv | grep GOOGLE   # confirm all three are set
```

## 6. Connect and verify in CareLane

1. Open **Settings → Google Calendar**. It should now show a **Connect Google
   Calendar** button (instead of "Not configured").
2. Click **Connect**, sign in with your test-user account, and grant calendar
   access. You'll be redirected back to Settings.
3. Click **Test connection** — a green result confirms the credentials reach the
   calendar.
4. Tick **Sync scheduled shifts to Google Calendar**, set the **Timezone**
   (e.g. `Australia/Perth`) and optionally a non-primary **Calendar ID**, then
   **Save**.
5. Click **Sync all shifts** to push your existing roster, or just create/edit a
   shift — it will appear on your calendar.

The status panel shows how many shifts are mirrored, the last successful sync
time, and the most recent error (with a **Clear** button to dismiss a stale one).

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Settings shows **"Not configured"** | The three `GOOGLE_*` env vars aren't reaching the app. Recreate the container and check `printenv \| grep GOOGLE`. |
| **403 — "API is not enabled"** on test or sync | You skipped step 2. Enable the Google Calendar API and wait a minute. |
| **403 — access denied** after connecting | The `calendar.events` scope wasn't granted, or your account isn't a test user. Re-check steps 3–4, then **Disconnect** and **Connect** again. |
| **400** on sync | A malformed event — make sure you're on a build that includes the latest sync fixes. |
| Redirect lands on an **error / "redirect_uri_mismatch"** | `GOOGLE_REDIRECT_URI` and the Authorised redirect URI in the console don't match exactly (trailing slash, http vs https, wrong path). |
| **"Google did not return a refresh token"** | Google only returns one on first consent. Revoke CareLane at <https://myaccount.google.com/permissions>, then reconnect. |
| Connected account email shows **blank** | Cosmetic — CareLane requests only the `calendar.events` scope, not your profile email. Sync still works. |
| Sync silently **stopped** after a week | A *Testing*-mode refresh token can expire. Reconnect, or publish the OAuth app. |

## Privacy note

Events written to Google contain only: a short participant label (preferred name
or initials), the location, and a generic description. No plan notes, health
information, or full participant records are ever sent. Sync is one-way
(CareLane → Google) and is a no-op until you connect and enable it.
