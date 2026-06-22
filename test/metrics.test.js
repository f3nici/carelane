import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { freshDb } from './helpers/db.js'

let metrics

beforeAll(async () => {
  await freshDb()
  metrics = await import('../server/services/metrics.js')
})

beforeEach(() => metrics.resetMetrics())

describe('metrics registry', () => {
  it('renders Prometheus exposition text with process + app gauges', () => {
    const out = metrics.render()
    expect(out).toMatch(/# TYPE carelane_up gauge/)
    expect(out).toMatch(/carelane_up 1/)
    expect(out).toMatch(/carelane_process_resident_memory_bytes \d+/)
    // App gauges derived from the (migrated, empty) DB.
    expect(out).toMatch(/carelane_clients_total 0/)
    expect(out).toMatch(/carelane_users_2fa_enabled \d+/)
  })

  it('counts HTTP requests by method and status and records latency', () => {
    metrics.recordHttpRequest('GET', 200, 12)
    metrics.recordHttpRequest('GET', 200, 30)
    metrics.recordHttpRequest('POST', 404, 5)
    const out = metrics.render()
    expect(out).toMatch(/carelane_http_requests_total\{method="GET",status="200"\} 2/)
    expect(out).toMatch(/carelane_http_requests_total\{method="POST",status="404"\} 1/)
    expect(out).toMatch(/carelane_http_request_duration_seconds_count 3/)
    expect(out).toMatch(/carelane_http_request_duration_seconds_bucket\{le="\+Inf"\} 3/)
  })

  it('gates the handler behind METRICS_TOKEN when configured', () => {
    const handler = metrics.metricsHandler({ metricsToken: 'secret' })

    // Minimal Express-style response recorder. status()/type() are chainable and
    // send() captures the final body.
    function makeRes () {
      const out = { code: 200, body: null }
      const res = {
        status (c) { out.code = c; return res },
        type () { return res },
        set () { return res },
        send (b) { out.body = b; return res }
      }
      return { res, out }
    }

    // No token → 401
    const a = makeRes()
    handler({ get: () => '', query: {} }, a.res)
    expect(a.out.code).toBe(401)

    // Correct bearer token → 200 with metrics
    const b = makeRes()
    handler({ get: () => 'Bearer secret', query: {} }, b.res)
    expect(b.out.code).toBe(200)
    expect(b.out.body).toMatch(/carelane_up 1/)
  })
})
