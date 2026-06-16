import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { getSetting } from './settingsService.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Passkeys (WebAuthn) as a passwordless login factor. Each registered
 * authenticator is one `webauthn_credentials` row. Public keys are not secret
 * (the private key never leaves the device), so nothing here is encrypted — the
 * security comes from the signature challenge/response, not from storage.
 *
 * The pending challenge for an in-flight ceremony is held on the session by the
 * route (`req.session.webauthnChallenge`); this service is given the expected
 * challenge/origin/rpID explicitly so it stays free of the request object.
 */

const now = () => new Date().toISOString()

/**
 * Resolve the relying-party id, friendly name and expected origin for a
 * request. Both id and origin are pinned by env when set, otherwise derived
 * from the browser-supplied Origin (or Host) so a same-origin deployment works
 * with no configuration.
 * @param {{ originHeader?: string, host?: string, protocol?: string }} ctx
 * @returns {{ rpID: string, rpName: string, origin: string }}
 */
export function resolveRp ({ originHeader, host, protocol = 'http' } = {}) {
  const origin = config.webauthnOrigin || originHeader || `${protocol}://${host}`
  let rpID = config.webauthnRpId
  if (!rpID) {
    try { rpID = new URL(origin).hostname } catch { rpID = 'localhost' }
  }
  const rpName = getSetting('business_name', 'CareLane') || 'CareLane'
  return { rpID, rpName, origin }
}

/** Map a stored row to the @simplewebauthn credential shape. */
function toCredential (row) {
  return {
    id: row.credential_id,
    publicKey: row.public_key, // Buffer is a Uint8Array
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : undefined
  }
}

/**
 * List a user's registered passkeys (safe metadata only — no key material).
 * @param {number} userId
 * @returns {Array<{ id:number, name:string, device_type:string, backed_up:boolean, created_at:string, last_used_at:string }>}
 */
export function listCredentials (userId) {
  return sqlite.prepare(
    'SELECT id, name, device_type, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at'
  ).all(userId).map(r => ({ ...r, backed_up: !!r.backed_up }))
}

/**
 * Build registration options for enrolling a new passkey. Existing credentials
 * are excluded so the same authenticator cannot be registered twice. The
 * returned `challenge` must be stored on the session for the verify step.
 * @param {number} userId
 * @param {object} user user row (for username/display name)
 * @param {{ rpID:string, rpName:string }} rp
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialCreationOptionsJSON>}
 */
export async function beginRegistration (userId, user, rp) {
  const existing = sqlite.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(userId)
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new TextEncoder().encode(String(userId)),
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined
    })),
    // Passwordless: a discoverable (resident) credential so the operator can log
    // in without first typing a username. userVerification is *required* so the
    // passkey is genuine two-factor (possession of the device + a biometric/PIN),
    // not possession alone.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
  })
}

/**
 * Verify and persist a new passkey registration.
 * @param {number} userId
 * @param {object} args
 * @param {object} args.response browser attestation response
 * @param {string} args.expectedChallenge challenge issued at begin time
 * @param {string} args.expectedOrigin
 * @param {string} args.expectedRPID
 * @param {string} [args.name] operator label for the device
 * @returns {Promise<{ id:number, name:string }>}
 */
export async function finishRegistration (userId, { response, expectedChallenge, expectedOrigin, expectedRPID, name }) {
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true
    })
  } catch (err) {
    throw new ApiError(400, 'PASSKEY_INVALID', err.message || 'Could not verify passkey registration')
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new ApiError(400, 'PASSKEY_INVALID', 'Passkey registration could not be verified')
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
  const exists = sqlite.prepare('SELECT 1 FROM webauthn_credentials WHERE credential_id = ?').get(credential.id)
  if (exists) throw new ApiError(409, 'PASSKEY_EXISTS', 'That passkey is already registered')

  const ts = now()
  const label = (name && name.trim()) || defaultLabel(credentialDeviceType)
  const info = sqlite.prepare(`INSERT INTO webauthn_credentials
    (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter ?? 0,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credentialDeviceType || null,
      credentialBackedUp ? 1 : 0,
      label,
      ts,
      ts
    )
  return { id: info.lastInsertRowid, name: label }
}

/**
 * Build authentication options for a usernameless (discoverable-credential)
 * passkey login. The returned `challenge` must be stored on the session.
 * @param {{ rpID:string }} rp
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialRequestOptionsJSON>}
 */
export async function beginLogin (rp) {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    allowCredentials: [] // discoverable credentials: let the authenticator choose
  })
}

/**
 * Verify a passkey assertion and resolve the owning user. Bumps the stored
 * signature counter (replay defence) on success.
 * @param {object} args
 * @param {object} args.response browser assertion response
 * @param {string} args.expectedChallenge
 * @param {string} args.expectedOrigin
 * @param {string} args.expectedRPID
 * @returns {Promise<object>} the authenticated user row
 */
export async function finishLogin ({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
  const row = sqlite.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(response?.id)
  if (!row) throw new ApiError(401, 'PASSKEY_UNKNOWN', 'Unrecognised passkey')

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      credential: toCredential(row),
      requireUserVerification: true
    })
  } catch (err) {
    throw new ApiError(401, 'PASSKEY_INVALID', err.message || 'Passkey verification failed')
  }
  if (!verification.verified) throw new ApiError(401, 'PASSKEY_INVALID', 'Passkey verification failed')

  sqlite.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, now(), row.id)

  const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
  if (!user) throw new ApiError(401, 'PASSKEY_INVALID', 'Passkey is not linked to an active account')
  return user
}

/**
 * Rename a passkey the user owns.
 * @param {number} userId
 * @param {number} id credential row id
 * @param {string} name
 */
export function renameCredential (userId, id, name) {
  const res = sqlite.prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?').run(name.trim(), id, userId)
  if (res.changes === 0) throw new ApiError(404, 'NOT_FOUND', 'Passkey not found')
}

/**
 * Delete a passkey the user owns (hard delete — a credential is not a regulated
 * record and the matching private key is gone once the device is de-registered).
 * @param {number} userId
 * @param {number} id credential row id
 */
export function deleteCredential (userId, id) {
  const res = sqlite.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, userId)
  if (res.changes === 0) throw new ApiError(404, 'NOT_FOUND', 'Passkey not found')
}

/** A friendly default label when the operator does not supply one. */
function defaultLabel (deviceType) {
  return deviceType === 'multiDevice' ? 'Passkey (synced)' : 'Passkey (this device)'
}
