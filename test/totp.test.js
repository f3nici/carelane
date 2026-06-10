import { describe, it, expect, vi, afterEach } from 'vitest'
import { base32Encode, base32Decode, generateToken, verifyToken, generateSecret, otpauthUri } from '../server/services/totpService.js'

afterEach(() => vi.useRealTimers())

describe('totpService', () => {
  it('round-trips base32 encoding', () => {
    const buf = Buffer.from('12345678901234567890')
    expect(base32Encode(buf)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(base32Encode(buf)).toString()).toBe('12345678901234567890')
  })

  it('matches the RFC 6238 SHA-1 test vector (6-digit, T=59s)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(59 * 1000))
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(verifyToken(secret, '287082')).toBe(true)
    expect(verifyToken(secret, '000000')).toBe(false)
  })

  it('accepts a freshly generated token and rejects malformed input', () => {
    const secret = generateSecret()
    expect(verifyToken(secret, generateToken(secret))).toBe(true)
    expect(verifyToken(secret, '12')).toBe(false)
    expect(verifyToken(secret, 'abcdef')).toBe(false)
    expect(verifyToken(secret, '')).toBe(false)
  })

  it('tolerates one step of clock drift but not two', () => {
    const secret = generateSecret()
    const now = Date.now()
    expect(verifyToken(secret, generateToken(secret, now - 30 * 1000))).toBe(true)
    expect(verifyToken(secret, generateToken(secret, now - 90 * 1000))).toBe(false)
  })

  it('builds a scannable otpauth URI', () => {
    const uri = otpauthUri('ABCDEF', 'admin', 'CareLane')
    expect(uri).toContain('otpauth://totp/CareLane%3Aadmin')
    expect(uri).toContain('secret=ABCDEF')
    expect(uri).toContain('issuer=CareLane')
  })
})
