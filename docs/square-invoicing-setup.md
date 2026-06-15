# Square invoicing setup

CareLane can turn a completed shift note into a **draft invoice** in your Square
account. The draft is never sent — CareLane only creates it, so you review and
send it yourself from Square. The invoice line item uses the **per-participant
rate** you set under each participant's billing codes.

> You need: a [Square](https://squareup.com/) account, and a few minutes in the
> [Square Developer Dashboard](https://developer.squareup.com/apps).

---

## Overview

You will:

1. Create an application in the Square Developer Dashboard.
2. Copy an **access token** (sandbox first, production when you're ready).
3. Put the token into CareLane's environment.
4. Connect from **Settings → Square invoicing** and verify with **Test connection**.
5. Set each participant's rates and generate a draft invoice from a shift note.

CareLane talks to Square over HTTPS using the access token — there is no OAuth
redirect to configure (unlike Google Calendar).

---

## 1. Create a Square application

1. Go to <https://developer.squareup.com/apps> and sign in with your Square account.
2. Click **+** (Create your first application / New application).
3. Name it (e.g. `CareLane`) and create it.

## 2. Get an access token

Square gives every application two completely separate sets of credentials:
**Sandbox** (fake data for testing) and **Production** (your real account).

Start with **Sandbox** so you can create test invoices safely:

1. Open your application → **Sandbox** in the environment switcher (top of the page).
2. Under **Credentials**, copy the **Sandbox Access Token**.

When you're happy it works, switch to **Production**:

1. Switch the environment to **Production**.
2. Under **Credentials → Production Access Token**, click to reveal/generate it
   and copy it. Treat this like a password — it can charge and invoice your real
   customers.

> The access token is the only secret CareLane needs. It is read from the
> environment and **never stored in the CareLane database** (the same as your
> Anthropic API key).

## 3. Configure CareLane's environment

Set these variables in your environment:

```bash
SQUARE_ACCESS_TOKEN=EAAA...            # the access token from step 2
SQUARE_ENVIRONMENT=sandbox             # 'sandbox' (default) or 'production'
# SQUARE_LOCATION_ID=L0CATION1D        # optional — auto-detected on Test connection
```

- `SQUARE_ENVIRONMENT` must match the token you pasted. A sandbox token with
  `SQUARE_ENVIRONMENT=production` (or vice-versa) will fail to authenticate.
- `SQUARE_LOCATION_ID` is optional. CareLane auto-detects your first active
  location the first time you click **Test connection**. Only set it if you have
  multiple locations and want to pin a specific one.

### Docker Compose

CareLane reads these from the container's environment — it does **not** auto-load
a `.env` file inside the app. The provided `docker-compose.yml` forwards the
variables:

```yaml
    environment:
      # ...
      SQUARE_ACCESS_TOKEN: ${SQUARE_ACCESS_TOKEN:-}
      SQUARE_ENVIRONMENT: ${SQUARE_ENVIRONMENT:-sandbox}
      SQUARE_LOCATION_ID: ${SQUARE_LOCATION_ID:-}
```

Put the values in the `.env` file next to `docker-compose.yml`, then **recreate**
the container so it picks up the new environment (a plain restart is not enough):

```bash
docker compose up -d
docker compose exec carelane printenv | grep SQUARE   # confirm they are set
```

## 4. Connect and verify in CareLane

1. Open **Settings → Square invoicing**. It should now show **Configured**
   (instead of "Not configured").
2. Click **Test connection** — a green result confirms the token reaches your
   account and shows the detected **location** and **currency**.
3. Tick **Enable creating Square invoices from shifts**, check the **Currency**
   (defaults to `AUD`), then **Save**.

The status panel shows how many draft invoices CareLane has created, the last
invoice time, and the most recent error (with a **Clear** button).

## 5. Set participant rates

The amount CareLane bills comes from the **rate you set per participant**, which
can differ from one participant to the next:

1. Open a participant → **Edit** → **Billing codes**.
2. Add the support items you bill for that participant.
3. Enter the **rate** (per hour / per unit) in the box next to each item. Leave it
   blank to fall back to the NDIS standard price-cap.

You can also set the **Invoice due (days)** on the participant's edit page — the
payment term used for that participant's invoices. Leave it blank to use the
default of **45 days**.

## 6. Generate a draft invoice from a shift

1. Open a shift note that has a **billing code** and a **duration**.
2. In the **Square invoice** card, click **Create draft invoice in Square**.
3. CareLane:
   - finds or creates a Square **customer** for the participant (using their
     email), caching the link so repeat invoices reuse it;
   - adds one **line item**: `<code> — <name>`, priced at the participant's rate ×
     hours;
   - creates the invoice as a **draft** addressed to the participant.
4. Open **Square → Invoices** to review the draft, then send it when you're ready.

The draft accepts **card** payment by default (the online method Square supports
in Australia). Since it's a draft, you can change the payment options — or add
bank-transfer instructions — in Square before sending.

The shift is marked **billed** once a draft has been created, and the shift page
shows the invoice status so you don't invoice the same shift twice.

### Plan-manager email

Square's Invoices API allows only **one** recipient on an invoice, so CareLane
sets the **participant** as the recipient and adds the **plan manager** (name +
email, taken from the participant's *Plan manager contact* field) as a **custom
field** and a line in the invoice description. When you review the draft in
Square, add the plan manager as an additional recipient there if your plan
supports it, or forward the sent invoice to them.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Settings shows **"Not configured"** | `SQUARE_ACCESS_TOKEN` isn't reaching the app. Recreate the container and check `printenv \| grep SQUARE`. |
| **Test connection** fails with `UNAUTHORIZED` | The token is wrong, revoked, or the **environment doesn't match** the token (sandbox token + production env, or vice-versa). |
| **"No Square locations found"** | The account has no active location. Create one in the Square Dashboard. |
| Generate fails with **"No rate set…"** | The participant has no rate for that billing code and the code has no standard price-cap. Set a rate under the participant's billing codes. |
| Generate fails with **"Shift note has no billing code"** | Add a billing code to the shift note first. |
| Generate fails with **"already has a Square invoice"** | A draft already exists for this shift. Open Square to find it, or cancel it there before re-invoicing. |
| Amounts look wrong | Money is sent to Square in the location's currency. Check the participant's rate and the shift duration. |

## Privacy note

Creating a Square customer/invoice necessarily sends the participant's **name,
email and phone** and the **billing code + amount** to Square — that is the
purpose of the integration. No plan notes, health information, incident details
or full participant records are sent. Invoices are created as drafts only;
nothing is sent to anyone until you send it from Square.
