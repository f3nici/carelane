import crypto from 'node:crypto'
import config from '../config.js'

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
