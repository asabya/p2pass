/**
 * IPNS key derivation from WebAuthn PRF seeds.
 *
 * Derives a deterministic Ed25519 keypair suitable for IPNS record
 * publishing/resolving, using HKDF over the PRF seed extracted during
 * WebAuthn authentication.
 *
 * @module recovery/ipns-key
 */

import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

const PREFIX = '[recovery]';

/**
 * Compute a deterministic PRF salt by hashing "p2p-passkeys:" + hostname.
 *
 * The salt is used in the WebAuthn PRF extension so the same passkey on
 * the same origin always produces the same seed material.
 *
 * @returns {Promise<Uint8Array>} 32-byte SHA-256 digest
 */
export async function computeDeterministicPrfSalt() {
  let hostname;
  try {
    hostname = location.hostname || 'localhost';
  } catch {
    hostname = 'localhost';
  }

  const input = `p2p-passkeys:${hostname}`;
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(hash);
}

/**
 * Derive a deterministic Ed25519 keypair from a PRF seed using HKDF.
 *
 * The derivation chain is:
 *   prfSeed  -->  HKDF(SHA-256, salt=SHA-256(prfSeed)[0:16],
 *                      info="p2p-passkeys/ipns-key")  -->  32-byte seed
 *           -->  Ed25519 keypair via libp2p/crypto
 *
 * @param {Uint8Array} prfSeed - raw PRF seed bytes
 * @returns {Promise<{ privateKey: object, publicKey: object }>} libp2p key objects
 */
export async function deriveIPNSKeyPair(prfSeed) {
  // Import the PRF seed as HKDF base key material
  const baseKey = await crypto.subtle.importKey(
    'raw',
    prfSeed,
    'HKDF',
    false,
    ['deriveBits']
  );

  // Derive a salt from the seed itself: SHA-256(prfSeed) truncated to 16 bytes
  const seedHash = await crypto.subtle.digest('SHA-256', prfSeed);
  const salt = new Uint8Array(seedHash).slice(0, 16);

  const info = new TextEncoder().encode('p2p-passkeys/ipns-key');

  // Derive 256 bits (32 bytes) of key material
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    256
  );

  const derivedSeed = new Uint8Array(derivedBits);

  // Generate the Ed25519 keypair from the deterministic seed
  const keyPair = await generateKeyPairFromSeed('Ed25519', derivedSeed);

  console.log(PREFIX, 'Derived IPNS Ed25519 keypair from PRF seed');

  return { privateKey: keyPair, publicKey: keyPair.publicKey };
}

/**
 * Recover a PRF seed by performing a discoverable-credential WebAuthn
 * assertion with the PRF extension.
 *
 * The browser will show its native passkey picker (no `allowCredentials`),
 * letting the user choose which credential to authenticate with.
 *
 * If the authenticator supports PRF, the raw PRF output is used as the seed.
 * Otherwise, `rawId` is used as a less-secure fallback.
 *
 * @returns {Promise<{ prfSeed: Uint8Array, rawCredentialId: Uint8Array, credential: object }>}
 */
export async function recoverPrfSeed() {
  const deterministicSalt = await computeDeterministicPrfSalt();

  console.log(PREFIX, 'Initiating discoverable-credential assertion for PRF seed recovery');

  let hostname;
  try {
    hostname = location.hostname || 'localhost';
  } catch {
    hostname = 'localhost';
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: hostname,
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: deterministicSalt } }
      }
    }
  });

  const rawCredentialId = new Uint8Array(assertion.rawId);

  // Try to extract PRF result
  const extResults = assertion.getClientExtensionResults?.();
  const prfResult = extResults?.prf?.results?.first;

  let prfSeed;
  if (prfResult) {
    prfSeed = new Uint8Array(prfResult);
    console.log(PREFIX, 'PRF seed recovered from authenticator extension');
  } else {
    // Fallback: use rawId as seed (less secure but functional)
    prfSeed = new Uint8Array(assertion.rawId);
    console.log(PREFIX, 'PRF not available, falling back to rawId as seed');
  }

  return { prfSeed, rawCredentialId, credential: assertion };
}
