import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers/db.js'

// Mock DNS so a public-looking hostname resolves to a private address — the
// SSRF case the literal-host check cannot catch on its own.
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => [{ address: '169.254.169.254', family: 4 }]) }
}))

let ntfy, settingsService, fetchMock

const now = () => new Date().toISOString()

beforeAll(async () => {
  await freshDb()
  settingsService = await import('../server/services/settingsService.js')
  ntfy = await import('../server/services/ntfyService.js')
})

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock
  settingsService.updateSettings({
    ntfy_enabled: 1,
    ntfy_topic: 'test-topic',
    // Passes the literal public-host check, but resolves (via the mock) to a
    // link-local / cloud-metadata address.
    ntfy_server_url: 'https://metadata.attacker.example',
    ntfy_last_error: null
  })
})

describe('ntfyService SSRF resolve-time guard', () => {
  it('refuses to publish when the hostname resolves to a private address', async () => {
    const res = await ntfy.publish({ message: 'x', now })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/private/i)
    // The request is never made.
    expect(fetchMock).not.toHaveBeenCalled()
    // And the live error banner is recorded for the settings UI.
    expect(settingsService.getSetting('ntfy_last_error')).toBeTruthy()
  })
})
