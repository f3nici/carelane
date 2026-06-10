import crypto from 'node:crypto'

/**
 * RFC 6238 TOTP primitives (SHA-1, 6 digits, 30s step) plus RFC 4648 base32
 * helpers. Pure functions — no database or encryption here; persistence and
 * at-rest encryption of the secret live in twoFactorService.
 */

const DIGITS = 6
const STEP_SECONDS = 30
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Generate a random base32 TOTP secret.
 * @param {number} [bytes] entropy in bytes (20 = 160 bits, the RFC default)
 * @returns {string} base32-encoded secret (no padding)
 */
export function generateSecret (bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes))
}

/**
 * Build the `otpauth://` provisioning URI an authenticator app scans.
 * @param {string} secret base32 secret
 * @param {string} account account label (e.g. username)
 * @param {string} issuer issuer/app name
 * @returns {string}
 */
export function otpauthUri (secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Compute the TOTP code for a given counter (time step).
 * @param {Buffer} key decoded secret bytes
 * @param {number} counter
 * @returns {string} zero-padded code
 */
function hotp (key, counter) {
  const buf = Buffer.alloc(8)
  // Counter is < 2^53, so the high word is written from the float and the low
  // word via BigInt-free arithmetic to stay within 32-bit writes.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * Generate the current TOTP code for a secret (used by tests and tooling).
 * @param {string} secret base32 secret
 * @param {number} [atMs] timestamp in ms (defaults to now)
 * @returns {string} 6-digit code
 */
export function generateToken (secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS)
  return hotp(base32Decode(secret), counter)
}

/**
 * Verify a submitted TOTP token, allowing ±`window` steps of clock drift.
 * @param {string} secret base32 secret
 * @param {string} token user-supplied code
 * @param {number} [window] steps of tolerance either side of now
 * @returns {boolean}
 */
export function verifyToken (secret, token, window = 1) {
  if (!secret || !token) return false
  const clean = String(token).replace(/\D/g, '')
  if (clean.length !== DIGITS) return false
  const key = base32Decode(secret)
  if (!key.length) return false
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(key, counter + i)
    // constant-time compare to avoid leaking which step matched via timing
    if (candidate.length === clean.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) return true
  }
  return false
}

/**
 * Encode bytes as RFC 4648 base32 (no padding).
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode (buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Decode an RFC 4648 base32 string to bytes. Ignores padding/whitespace/case.
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode (input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
