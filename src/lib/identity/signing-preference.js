/**
 * User-selectable signing strategy for OrbitDB WebAuthn DID (hardware Ed25519, hardware P-256, or worker Ed25519).
 *
 * Maps to {@link IdentityService} `initialize` options and WebAuthn `forceP256` in the upstream provider.
 *
 * @module identity/signing-preference
 */

export const SIGNING_PREFERENCE_STORAGE_KEY = 'p2p_passkeys_signing_preference';

/** @typedef {'hardware-ed25519' | 'hardware-p256' | 'worker'} SigningPreference */

/** @type {SigningPreference[]} */
export const SIGNING_PREFERENCE_LIST = ['hardware-ed25519', 'hardware-p256', 'worker'];

/**
 * @param {unknown} v
 * @returns {v is SigningPreference}
 */
export function isSigningPreference(v) {
  return v === 'hardware-ed25519' || v === 'hardware-p256' || v === 'worker';
}

/**
 * @returns {SigningPreference|null}
 */
export function readSigningPreferenceFromStorage() {
  if (typeof globalThis.localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(SIGNING_PREFERENCE_STORAGE_KEY);
    return isSigningPreference(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {SigningPreference} pref
 */
export function writeSigningPreferenceToStorage(pref) {
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    localStorage.setItem(SIGNING_PREFERENCE_STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ signingPreference?: SigningPreference | null, preferWorkerMode?: boolean }} opts
 * @returns {SigningPreference}
 */
export function resolveSigningPreference(opts) {
  const { signingPreference, preferWorkerMode } = opts;
  if (preferWorkerMode) return 'worker';
  if (signingPreference && isSigningPreference(signingPreference)) return signingPreference;
  return 'hardware-ed25519';
}
