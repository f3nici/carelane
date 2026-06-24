# Metrics (Prometheus) setup

CareLane can expose a [Prometheus](https://prometheus.io/) metrics endpoint at
`GET /metrics` so self-hosters running their own monitoring can chart request
rates, latency, memory use and a handful of application gauges (active clients,
unfinalised notes, open incidents, …).

It is **disabled by default**. Nothing is collected or exposed until you turn it
on. The endpoint carries only operational counters — never participant PII,
note bodies, query strings or request paths (HTTP series are labelled by method
and status code only, to keep the cardinality bounded).

> You need: a Prometheus server (or any agent that can scrape the Prometheus
> text format — Grafana Agent, VictoriaMetrics, the OpenTelemetry Collector,
> etc.). CareLane only *exposes* metrics; it does not store or graph them.

---

## Overview

You will:

1. **Enable** the endpoint with `METRICS_ENABLED=true`.
2. Optionally **protect** it with a bearer token (`METRICS_TOKEN`).
3. Point your **Prometheus scrape config** at `/metrics`.
4. (Optional) Chart the series in Grafana.

---

## 1. Enable the endpoint

Set the environment variable and restart the container:

```bash
METRICS_ENABLED=true
```

`/metrics` is mounted **before** the authentication stack (like `/healthz`), so
a scraper does not need a login session. It is also excluded from the access log
and from the request metrics themselves, so a frequent scrape won't flood your
logs or inflate the counters.

Verify it:

```bash
curl -s http://localhost:3778/metrics | head
```

You should see lines like:

```
# HELP carelane_up Whether the service is responding (always 1 when scraped).
# TYPE carelane_up gauge
carelane_up 1
```

## 2. Protect it with a token (recommended if reachable)

With no token the endpoint is **open** — fine for an internal-only scrape target
that isn't reachable from outside your network (the same posture as `/healthz`).
If the port is reachable from anywhere else, set a token:

```bash
METRICS_TOKEN=a-long-random-string
```

The scraper must then present it, either as a bearer header or a query param:

```bash
curl -s -H "Authorization: Bearer a-long-random-string" http://localhost:3778/metrics
# or
curl -s "http://localhost:3778/metrics?token=a-long-random-string"
```

The token is compared in constant time, so it can't be recovered byte-by-byte
from response timing. A missing/wrong token returns `401`.

## 3. Scrape it from Prometheus

Add a job to your `prometheus.yml`. Without a token:

```yaml
scrape_configs:
  - job_name: carelane
    metrics_path: /metrics
    static_configs:
      - targets: ['carelane:3778']   # host:port of your CareLane container
```

With a token, pass it as a bearer credential:

```yaml
scrape_configs:
  - job_name: carelane
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: a-long-random-string
    static_configs:
      - targets: ['carelane:3778']
```

If CareLane is served over HTTPS behind a reverse proxy, add `scheme: https`
and point the target at the proxy.

---

## What's exposed

All series are prefixed `carelane_`.

### Process / runtime

| Metric | Type | Meaning |
|--------|------|---------|
| `carelane_up` | gauge | Always `1` when the scrape succeeds (use `up{job="carelane"}` for liveness). |
| `carelane_process_uptime_seconds` | gauge | Seconds since the process started. |
| `carelane_process_resident_memory_bytes` | gauge | Resident set size (RSS). |
| `carelane_nodejs_heap_used_bytes` | gauge | V8 heap in use. |

### HTTP traffic

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `carelane_http_requests_total` | counter | `method`, `status` | Total HTTP requests. |
| `carelane_http_request_duration_seconds` | histogram | — | Request latency (buckets + `_sum`/`_count`). |

Note the labels are deliberately low-cardinality: **method and status code only**,
never the path (which carries record ids). `/healthz` and `/metrics` are not
counted.

### Application gauges

Computed from the database at scrape time (cheap `COUNT(*)`s; a missing table
just omits that one metric rather than failing the scrape):

| Metric | Meaning |
|--------|---------|
| `carelane_clients_total` | Active (non-deleted) participant records. |
| `carelane_shift_notes_total` | Active shift notes. |
| `carelane_shift_notes_unfinalised` | Shift notes not yet finalised. |
| `carelane_incident_reports_open` | Incident reports not yet closed. |
| `carelane_users_total` | User accounts. |
| `carelane_users_2fa_enabled` | User accounts with TOTP enabled. |
| `carelane_audit_log_entries` | Append-only audit-log rows. |
| `carelane_active_sessions` | Unexpired login sessions. |
| `carelane_throttle_locked_keys` | Login/rate-limit keys currently locked out. |

---

## Example queries (PromQL)

```promql
# Request rate by status, over 5m
sum by (status) (rate(carelane_http_requests_total[5m]))

# 95th-percentile latency
histogram_quantile(0.95, sum by (le) (rate(carelane_http_request_duration_seconds_bucket[5m])))

# Error ratio (4xx+5xx as a fraction of all requests)
sum(rate(carelane_http_requests_total{status=~"4..|5.."}[5m]))
  / sum(rate(carelane_http_requests_total[5m]))

# Is it up?
up{job="carelane"}

# Shift notes still awaiting finalisation
carelane_shift_notes_unfinalised
```

Useful alerts: `up{job="carelane"} == 0` (service down),
`carelane_throttle_locked_keys > 0` (someone is being locked out — possible
brute-force), and a sustained high error ratio.

---

## Notes & privacy

- Metrics are operational only. The endpoint never exposes participant data,
  note contents, or even request paths.
- The HTTP **access log** is a separate concern, tuned with `LOG_HTTP`
  (`all` / `sampled` / `errors` / `off`) and `LOG_FORMAT` — see
  [`.env.example`](../.env.example).
- Leave `METRICS_ENABLED=false` if you don't run monitoring; there is no cost to
  having it off.
