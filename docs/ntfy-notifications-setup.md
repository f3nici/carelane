# Push notifications (ntfy) setup

CareLane can push **proactive nudges** to your phone — so you don't have to open
the dashboard to notice that something needs attention. It uses
[ntfy](https://ntfy.sh/), a dead-simple pub/sub notification service: you pick a
**topic** (a secret-ish name), subscribe to it in the ntfy app, and CareLane
publishes short messages to it.

CareLane notifies you about:

- **Plan reviews due** — active service agreements whose end date is approaching.
- **Incidents needing follow-up** — open/in-progress incident reports (overdue
  ones are called out).
- **Unbilled shifts aging** — finalised shifts that still haven't been billed.
- **Upcoming shifts** — a reminder a configurable time before each scheduled shift.
- **Participant birthdays** — a nudge a configurable number of days ahead
  (30 days and 1 day before, by default).

> You need: the **ntfy app** ([iOS](https://apps.apple.com/app/ntfy/id1625396347)
> / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / or
> the [web app](https://ntfy.sh/app)). Nothing else is required to use the public
> `ntfy.sh` server — there is no account or API key to set up.

---

## Overview

You will:

1. Choose a **hard-to-guess topic name**.
2. **Subscribe** to that topic in the ntfy app on your phone.
3. Enter the topic under **Settings → Push notifications (ntfy)**, enable it, and
   click **Send test**.
4. Tune which nudges you want and their timing.

Anyone who knows your topic name can read your notifications (and publish to it),
so treat the topic like a password — e.g. `carelane-7f3a9c2b`, not `carelane`.

---

## 1. Choose a topic and subscribe on your phone

1. Install the ntfy app and open it.
2. Tap **+ / Subscribe to topic**.
3. Enter a unique topic name, e.g. `carelane-7f3a9c2b`. Leave the server as the
   default (`ntfy.sh`) unless you run your own (see below).
4. Subscribe. The app will now receive anything published to that topic.

## 2. Configure CareLane

1. Open **Settings → Push notifications (ntfy)**.
2. Enter the **same topic** you subscribed to.
3. Tick **Enable push notifications** and click **Save**.
4. Click **Send test** — a notification should arrive on your phone within a few
   seconds. (If it doesn't, see *Troubleshooting* below.)

You can also click **Send digest now** to immediately push whatever currently
needs attention — handy for confirming the content.

## 3. Choose what to notify about and when

In the same settings card:

- **What to notify about** — toggle each of the five categories independently.
- **Daily digest time** — when the plan-review, incident, unbilled and birthday
  nudges go out each day (in your operator timezone). One notification per
  non-empty category.
- **Remind me before a shift** — how many minutes ahead of a scheduled shift to
  push its reminder (e.g. `60`). Reminders only fire for shifts that have a start
  time, and each shift is reminded once.
- **Plan review lead time** — how many days before an agreement's end date to
  start nudging.
- **Unbilled shift age** — how old a finalised-but-unbilled shift must be before
  it's nudged, so brand-new shifts aren't flagged immediately.
- **Birthday reminders** — a comma-separated list of lead marks in days before a
  participant's birthday (e.g. `30,1`). A birthday only fires on the days exactly
  that far ahead, so you get a heads-up 30 days out and a final reminder the day
  before — never a nudge every day in between. Clear the field to disable the
  marks without turning the category off.

Participant birthdays also appear on the **iCal calendar subscription** (the
"Calendar subscription" panel on the Roster page) as all-day, yearly-recurring
events (scoped like the roster), so any calendar app you subscribe shows them
alongside your shifts.

---

## A note on the request timeout

ntfy notifications are sent over HTTPS to the ntfy server. If the server is
**far away or self-hosted**, the request can take well over a second to respond —
so CareLane uses a **generous timeout (10 seconds by default)**. A too-tight
timeout silently drops notifications when the round-trip is slow.

Tune it in the **settings card** — the **Request timeout** field (milliseconds).
Raise it (e.g. `15000` for up to 15s) for a slow or remote server; the value is
saved with your other notification settings, so no redeploy or environment
variable is needed.

## Self-hosting ntfy / protected topics (optional)

By default CareLane publishes to the public `ntfy.sh` server. To use your own
ntfy server, just change the **server URL** in the settings card. The URL must be
a public `http(s)` address: saving it rejects a private/loopback host, and every
send additionally resolves the hostname and refuses to publish if it points at a
private, loopback or link-local address (SSRF protection), so the server URL
can't be used to probe the host's own network or a cloud metadata endpoint.

If your server requires authentication (or you've made the topic
[access-protected](https://docs.ntfy.sh/config/#access-control)), provide an
access token via the environment — it's a secret, so it's read from env and never
stored in the database:

```bash
NTFY_TOKEN=tk_xxxxxxxxxxxxxxxxxxxxx
```

### Deep links back to CareLane

Set `APP_BASE_URL` to your install's public URL so each notification links
straight to the relevant page (the roster, incidents, etc.) when tapped:

```bash
APP_BASE_URL=https://carelane.example.org
```

### Docker Compose

CareLane reads these from the container's environment. Forward the variables in
`docker-compose.yml`:

```yaml
    environment:
      # ...
      NTFY_TOKEN: ${NTFY_TOKEN:-}
      APP_BASE_URL: ${APP_BASE_URL:-}
```

Put the values in the `.env` next to `docker-compose.yml`, then **recreate** the
container so it picks up the new environment (a plain restart is not enough):

```bash
docker compose up -d
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Test push never arrives | Confirm the topic in CareLane **exactly matches** the one you subscribed to, and that your phone has the topic subscribed. Check the **Last error** banner in Settings. |
| **"ntfy request timed out"** in the error banner | The server was too slow to respond. Raise the **Request timeout** in the settings card (e.g. `15000`) and save. |
| Error mentions `403` / unauthorized | The topic is access-protected or the server needs auth. Set `NTFY_TOKEN`. |
| Digest never goes out | Check **Enable push notifications** is on, the **digest time** matches your timezone, and at least one category is toggled on with items pending (the preview counts show what would send). |
| Shift reminders don't fire | Reminders only apply to scheduled shifts that have a **start time** and are still `scheduled`. Past or all-day shifts are skipped. |

## Privacy note

Notifications carry only a **short participant label** (preferred name or
initials), **counts**, and a shift's title/time/location — never plan notes,
health information, or incident narratives. This mirrors how CareLane minimises
what it sends to Google Calendar and the AI drafting calls. Remember that anyone
who knows your **topic name** can read these messages, so keep it private and use
a protected/self-hosted topic if you want stronger access control.
