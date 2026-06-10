import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let twoFactor, totp, sqlite, userId

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  twoFactor = await import('../server/services/twoFactorService.js')
  totp = await import('../server/services/totpService.js')
  userId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', 'x', 'admin')").run().lastInsertRowid
})

describe('twoFactorService enrolment + login', () => {
  it('enrols with a valid code and stores the secret encrypted', () => {
    const { secret } = twoFactor.beginSetup(userId)
    expect(twoFactor.getStatus(userId)).toEqual({ enabled: false, pending: true })

    const raw = sqlite.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId)
    expect(raw.totp_secret).toMatch(/^enc:/)
    expect(raw.totp_secret).not.toContain(secret)

    const { recovery_codes: codes } = twoFactor.confirmSetup(userId, totp.generateToken(secret))
    expect(codes).toHaveLength(10)
    expect(twoFactor.getStatus(userId)).toEqual({ enabled: true, pending: false })
  })

  it('rejects enrolment with a wrong code', () => {
    const id = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('two', 'x', 'admin')").run().lastInsertRowid
    twoFactor.beginSetup(id)
    expect(() => twoFactor.confirmSetup(id, '000000')).toThrow(/incorrect|expired/i)
  })

  it('verifies a login TOTP code', async () => {
    const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const secret = (await import('../server/services/cryptoService.js')).decrypt(user.totp_secret)
    expect(twoFactor.verifyLogin(user, totp.generateToken(secret))).toBe(true)
    expect(twoFactor.verifyLogin(user, '000000')).toBe(false)
  })

  it('accepts a recovery code once, then consumes it', () => {
    const id = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('three', 'x', 'admin')").run().lastInsertRowid
    const { secret } = twoFactor.beginSetup(id)
    const { recovery_codes: codes } = twoFactor.confirmSetup(id, totp.generateToken(secret))
    expect(twoFactor.recoveryCodesRemaining(id)).toBe(10)

    const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id)
    expect(twoFactor.verifyLogin(user, codes[0])).toBe(true)
    expect(twoFactor.recoveryCodesRemaining(id)).toBe(9)

    // Same code cannot be reused.
    const after = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id)
    expect(twoFactor.verifyLogin(after, codes[0])).toBe(false)
  })

  it('disable clears the secret and recovery codes', () => {
    const id = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('four', 'x', 'admin')").run().lastInsertRowid
    const { secret } = twoFactor.beginSetup(id)
    twoFactor.confirmSetup(id, totp.generateToken(secret))
    twoFactor.disable(id)
    const raw = sqlite.prepare('SELECT totp_secret, totp_enabled, totp_recovery_codes FROM users WHERE id = ?').get(id)
    expect(raw.totp_enabled).toBe(0)
    expect(raw.totp_secret).toBeNull()
    expect(raw.totp_recovery_codes).toBeNull()
  })
})
