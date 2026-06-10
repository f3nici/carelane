import { describe, it, expect, beforeEach } from 'vitest'
import { throttleKey, checkLockout, recordFailure, clearAttempts, resetAll } from '../server/services/loginThrottle.js'

beforeEach(() => resetAll())

describe('loginThrottle', () => {
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
})
