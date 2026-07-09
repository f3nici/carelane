/**
 * PII-at-rest encryption, host-agnostic. AES-256-GCM with a per-record random
 * IV. Ciphertext format: `enc:<iv b64>:<auth tag b64>:<ciphertext b64>`.
 *
 * The low-level primitives are injected as a {@link CryptoProvider} so the same
 * logic runs in Node (`node:crypto`) and React Native
 * (`react-native-quick-crypto`, which mirrors the `node:crypto` API). The key is
 * derived from the shared `encryptionSecret` — rotating that secret makes
 * existing ciphertext unreadable, so treat it as permanent.
 *
 * @typedef {object} CryptoProvider node:crypto-compatible primitive surface
 * @property {(secret:string|Buffer, salt:string|Buffer, keylen:number)=>Buffer} scryptSync scrypt key derivation
 * @property {(size:number)=>Buffer} randomBytes cryptographically-random bytes (the per-record IV)
 * @property {(algorithm:string, key:Buffer, iv:Buffer)=>any} createCipheriv AES-256-GCM cipher
 * @property {(algorithm:string, key:Buffer, iv:Buffer)=>any} createDecipheriv AES-256-GCM decipher
 * @property {(algorithm:string, key:Buffer)=>any} createHmac HMAC for the blind index
 */

const PREFIX = 'enc:'
const CANARY_KEY = 'enc_canary'
const CANARY_PLAINTEXT = 'carelane-encryption-canary-v1'

/**
 * Build the crypto service bound to a host's {@link CryptoProvider}. Preserves
 * the exact wire format and salts so ciphertext stays portable between hosts
 * (given the same `encryptionSecret`).
 * @param {{ crypto: CryptoProvider, encryptionSecret: string, sqlite: any }} ctx
 * @returns {{ encrypt:Function, decrypt:Function, blindIndex:Function, encryptFields:Function, decryptFields:Function, assertEncryptionCanary:Function }}
 */
export function createCryptoService (ctx) {
  const { crypto, encryptionSecret, sqlite } = ctx
  const key = crypto.scryptSync(encryptionSecret, 'carelane-pii-v1', 32)
  const hmacKey = crypto.scryptSync(encryptionSecret, 'carelane-blind-index-v1', 32)

  /**
   * Encrypt a plaintext string. Null/empty values pass through unchanged.
   * @param {string|null|undefined} plaintext
   * @returns {string|null}
   */
  function encrypt (plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext ?? null
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return PREFIX + [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':')
  }

  /**
   * Decrypt a value produced by {@link encrypt}. Values without the `enc:`
   * prefix are returned as-is (pre-encryption legacy data).
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  function decrypt (value) {
    if (value === null || value === undefined || value === '') return value ?? null
    if (!String(value).startsWith(PREFIX)) return value
    const [ivB64, tagB64, dataB64] = String(value).slice(PREFIX.length).split(':')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  }

  /**
   * Deterministic HMAC blind index for exact-match lookup on encrypted fields
   * (e.g. NDIS number) without storing the plaintext.
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  function blindIndex (value) {
    if (!value) return null
    return crypto.createHmac('sha256', hmacKey).update(String(value).trim()).digest('hex')
  }

  /**
   * Encrypt the listed fields of an object in place (returns a shallow copy).
   * @param {object} obj
   * @param {string[]} fields
   */
  function encryptFields (obj, fields) {
    const out = { ...obj }
    for (const f of fields) if (f in out) out[f] = encrypt(out[f])
    return out
  }

  /**
   * Decrypt the listed fields of an object (returns a shallow copy).
   * @param {object} obj
   * @param {string[]} fields
   */
  function decryptFields (obj, fields) {
    if (!obj) return obj
    const out = { ...obj }
    for (const f of fields) if (f in out) out[f] = decrypt(out[f])
    return out
  }

  /**
   * Verify that `encryptionSecret` still matches the one PII was encrypted with.
   *
   * On first run a canary ciphertext is sealed and stored in `settings`. On every
   * subsequent boot it is decrypted and compared: if the secret changed, every
   * encrypted PII column has silently become unreadable, so we throw loudly
   * instead of serving garbage or corrupting data on the next write.
   *
   * @returns {{ created: boolean }} `created:true` when the canary was just sealed
   * @throws {Error} when the stored canary cannot be decrypted/verified
   */
  function assertEncryptionCanary () {
    const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(CANARY_KEY)
    if (!row || !row.value) {
      const sealed = encrypt(CANARY_PLAINTEXT)
      sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(CANARY_KEY, sealed)
      return { created: true }
    }
    let decrypted
    try {
      decrypted = decrypt(row.value)
    } catch {
      throw new Error('ENCRYPTION_SECRET does not match the secret used to encrypt existing data — the encryption canary failed to decrypt. Refusing to start so PII is not corrupted. Restore the original ENCRYPTION_SECRET (it cannot be rotated casually).')
    }
    if (decrypted !== CANARY_PLAINTEXT) {
      throw new Error('ENCRYPTION_SECRET mismatch — the encryption canary decrypted to an unexpected value. Refusing to start. Restore the original ENCRYPTION_SECRET.')
    }
    return { created: false }
  }

  /**
   * Non-throwing counterpart to {@link assertEncryptionCanary}: does the current
   * `encryptionSecret` match the sealed canary? Returns true when no canary
   * exists yet (first run — nothing to mismatch) or it decrypts to the expected
   * value; false when a canary exists but the secret no longer matches. Lets a
   * data migration avoid writing fresh ciphertext under a wrong secret before the
   * boot canary aborts startup.
   * @returns {boolean}
   */
  function encryptionSecretMatches () {
    const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(CANARY_KEY)
    if (!row || !row.value) return true
    try { return decrypt(row.value) === CANARY_PLAINTEXT } catch { return false }
  }

  return { encrypt, decrypt, blindIndex, encryptFields, decryptFields, assertEncryptionCanary, encryptionSecretMatches }
}
