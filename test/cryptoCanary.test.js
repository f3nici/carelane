import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let crypto, sqlite

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  crypto = await import('../server/services/cryptoService.js')
})

describe('encryption-secret canary', () => {
  it('seals a canary on first run, then verifies cleanly afterwards', () => {
    expect(crypto.assertEncryptionCanary()).toEqual({ created: true })
    expect(crypto.assertEncryptionCanary()).toEqual({ created: false })
  })

  it('throws when the stored canary decrypts to the wrong plaintext', () => {
    // Same key, different plaintext — simulates a swapped/altered canary row.
    const wrong = crypto.encrypt('not-the-canary')
    sqlite.prepare('UPDATE settings SET value = ? WHERE key = ?').run(wrong, 'enc_canary')
    expect(() => crypto.assertEncryptionCanary()).toThrow(/ENCRYPTION_SECRET/)
  })

  it('throws when the canary ciphertext is undecryptable (secret changed)', () => {
    sqlite.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('enc:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB:CCCC', 'enc_canary')
    expect(() => crypto.assertEncryptionCanary()).toThrow(/ENCRYPTION_SECRET/)
  })
})
