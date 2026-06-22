import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { freshDb } from './helpers/db.js'

let throttleKey, checkLockout, recordFailure, clearAttempts, resetAll, purgeExpired

// The throttle is now DB-backed, so point at a throwaway database (with the
// throttle_hits table migrated in) before importing the service.
beforeAll(async () => {
  await freshDb()
  ;({ throttleKey, checkLockout, recordFailure, clearAttempts, resetAll, purgeExpired } =
    await import('../server/services/loginThrottle.js'))
})

beforeEach(() => resetAll())

describe('loginThrottle (DB-backed)', () => {
  it('locks out after the configured number of failures (default 5)', () => {
    const key = throttleKey('1.2.3.4', 'admin')
    for (let i = 0; i < 4; i++) {
      expect(recordFailure(key).locked).toBe(false)
      expect(checkLockout(key).locked).toBe(false)
    }
    expect(recordFailure(key).locked).toBe(true)
    const lock = checkLockout(key)
    expect(lock.locked).toBe(true)
    expect(lock.retryAfter).toBeGreaterThan(0)
  })

  it('a successful login clears the failure history', () => {
    const key = throttleKey('1.2.3.4', 'admin')
    recordFailure(key)
    recordFailure(key)
    clearAttempts(key)
    expect(checkLockout(key).locked).toBe(false)
  })

  it('keys are scoped per ip+username so accounts do not lock each other out', () => {
    const a = throttleKey('1.2.3.4', 'admin')
    const b = throttleKey('1.2.3.4', 'worker')
    for (let i = 0; i < 5; i++) recordFailure(a)
    expect(checkLockout(a).locked).toBe(true)
    expect(checkLockout(b).locked).toBe(false)
  })

  it('persists the lockout across a fresh import (survives a restart)', async () => {
    const key = throttleKey('5.6.7.8', 'admin')
    for (let i = 0; i < 5; i++) recordFailure(key)
    // Re-import the module to simulate a process restart sharing the same DB.
    const reimported = await import('../server/services/loginThrottle.js?restart')
    expect(reimported.checkLockout(key).locked).toBe(true)
  })

  it('purgeExpired leaves in-window buckets untouched', () => {
    const key = throttleKey('9.9.9.9', 'admin')
    recordFailure(key)
    expect(purgeExpired()).toBe(0)
    expect(checkLockout(key).locked).toBe(false)
  })
})
