import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let crypto

beforeAll(async () => {
  await freshDb()
  crypto = await import('../server/services/cryptoService.js')
})

describe('cryptoService round-trip', () => {
  it('encrypts then decrypts back to the original plaintext', () => {
    const plaintext = 'Jane Citizen — 0412 345 678'
    const sealed = crypto.encrypt(plaintext)
    expect(sealed).toMatch(/^enc:/)
    expect(sealed).not.toContain(plaintext)
    expect(crypto.decrypt(sealed)).toBe(plaintext)
  })

  it('uses a fresh IV so the same plaintext yields different ciphertext', () => {
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'))
  })

  it('passes null/empty values through unchanged', () => {
    expect(crypto.encrypt(null)).toBeNull()
    expect(crypto.encrypt('')).toBe('')
    expect(crypto.decrypt(null)).toBeNull()
    expect(crypto.decrypt('plain legacy value')).toBe('plain legacy value')
  })

  it('throws when ciphertext has been tampered with', () => {
    const sealed = crypto.encrypt('secret')
    const tampered = sealed.slice(0, -4) + 'AAAA'
    expect(() => crypto.decrypt(tampered)).toThrow()
  })

  it('blind index is deterministic and value-specific', () => {
    expect(crypto.blindIndex('430000001')).toBe(crypto.blindIndex('430000001'))
    expect(crypto.blindIndex('430000001')).not.toBe(crypto.blindIndex('430000002'))
    expect(crypto.blindIndex(null)).toBeNull()
  })

  it('encryptFields/decryptFields only touch the named fields', () => {
    const row = { first_name: 'Ada', suburb: 'Perth' }
    const enc = crypto.encryptFields(row, ['first_name'])
    expect(enc.first_name).toMatch(/^enc:/)
    expect(enc.suburb).toBe('Perth')
    expect(crypto.decryptFields(enc, ['first_name']).first_name).toBe('Ada')
  })
})
