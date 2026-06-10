import crypto from 'node:crypto'
import config from '../config.js'
import { sqlite } from '../db/connection.js'

/**
 * PII-at-rest encryption. AES-256-GCM with a per-record random IV.
 * Ciphertext format: `enc:<iv b64>:<auth tag b64>:<ciphertext b64>`.
 * The key is derived from ENCRYPTION_SECRET — rotating that secret makes
 * existing ciphertext unreadable, so treat it as permanent.
 * Encryption/decryption happens in the service layer only.
 */
const key = crypto.scryptSync(config.encryptionSecret, 'carelane-pii-v1', 32)
const hmacKey = crypto.scryptSync(config.encryptionSecret, 'carelane-blind-index-v1', 32)
const PREFIX = 'enc:'

/**
 * Encrypt a plaintext string. Null/empty values pass through unchanged.
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
export function encrypt (plaintext) {
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
export function decrypt (value) {
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
export function blindIndex (value) {
  if (!value) return null
  return crypto.createHmac('sha256', hmacKey).update(String(value).trim()).digest('hex')
}

/**
 * Encrypt the listed fields of an object in place (returns a shallow copy).
 * @param {object} obj
 * @param {string[]} fields
 */
export function encryptFields (obj, fields) {
  const out = { ...obj }
  for (const f of fields) if (f in out) out[f] = encrypt(out[f])
  return out
}

/**
 * Decrypt the listed fields of an object (returns a shallow copy).
 * @param {object} obj
 * @param {string[]} fields
 */
export function decryptFields (obj, fields) {
  if (!obj) return obj
  const out = { ...obj }
  for (const f of fields) if (f in out) out[f] = decrypt(out[f])
  return out
}

/** Known plaintext sealed under ENCRYPTION_SECRET and checked on every boot. */
const CANARY_KEY = 'enc_canary'
const CANARY_PLAINTEXT = 'carelane-encryption-canary-v1'

/**
 * Verify that ENCRYPTION_SECRET still matches the one PII was encrypted with.
 *
 * On first run a canary ciphertext is sealed and stored in `settings`. On every
 * subsequent boot it is decrypted and compared: if the secret changed, every
 * encrypted PII column has silently become unreadable, so we throw loudly
 * instead of serving garbage or corrupting data on the next write.
 *
 * @returns {{ created: boolean }} `created:true` when the canary was just sealed
 * @throws {Error} when the stored canary cannot be decrypted/verified
 */
export function assertEncryptionCanary () {
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
