/**
 * Multi-Device Registry for OrbitDB WebAuthn
 *
 * Manages a KV store of registered devices, UCAN delegations, and encrypted
 * Ed25519 archives using OrbitDBAccessController so write access can be
 * dynamically granted to new devices.
 *
 * Key prefixes:
 *   (none)          — device entries (keyed by sha256(credentialId))
 *   delegation:     — UCAN delegation proofs
 *   archive:        — encrypted Ed25519 archives
 *   keypair:        — Ed25519 keypair metadata (publicKey + DID, no private key)
 *
 * Copied from orbitdb-identity-provider-webauthn-did/src/multi-device/device-registry.js
 * and extended with delegation + archive + keypair storage.
 */

import { OrbitDBAccessController } from '@orbitdb/core';

/**
 * Convert P-256 x/y byte arrays from a WebAuthn attestation into JWK format.
 * @param {Uint8Array} x - 32-byte x coordinate
 * @param {Uint8Array} y - 32-byte y coordinate
 * @returns {Object} JWK object
 */
export function coseToJwk(x, y) {
  const toBase64url = (bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64url(x),
    y: toBase64url(y),
  };
}

/**
 * Hash a string to a 64-char lowercase hex key for DB storage.
 * @param {string} input - string to hash
 * @returns {Promise<string>} 64-char hex string
 */
export async function hashCredentialId(input) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Open (or create) the multi-device registry KV database.
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} ownerIdentityId - Ed25519 DID of the device creating the registry
 * @param {string} [address] - Existing DB address to reopen (for Device B)
 * @returns {Promise<Object>} Opened OrbitDB KeyValue database
 */
export async function openDeviceRegistry(orbitdb, ownerIdentityId, address = null) {
  if (address) {
    return await orbitdb.open(address, {
      type: 'keyvalue',
      sync: true,
    });
  }

  return await orbitdb.open('multi-device-registry', {
    type: 'keyvalue',
    sync: true,
    AccessController: OrbitDBAccessController({ write: [orbitdb.identity.id, ownerIdentityId] }),
  });
}

// ---------------------------------------------------------------------------
// Device entries
// ---------------------------------------------------------------------------

/**
 * Register a device entry in the registry.
 * @param {Object} db - OrbitDB KV database
 * @param {Object} entry - { credential_id, public_key, device_label, created_at, status, ed25519_did }
 */
export async function registerDevice(db, entry) {
  const key = await hashCredentialId(entry.credential_id);
  const existing = await db.get(key);
  if (existing) return;
  await db.put(key, entry);
}

/**
 * List all registered devices from the registry.
 * @param {Object} db - OrbitDB KV database
 * @returns {Promise<Array>} Array of device entry objects
 */
export async function listDevices(db) {
  const all = await db.all();
  return all
    .filter(
      (e) =>
        !e.key?.startsWith?.('delegation:') &&
        !e.key?.startsWith?.('archive:') &&
        !e.key?.startsWith?.('keypair:')
    )
    .map((e) => e.value);
}

/**
 * Look up a device by its credential ID.
 * @param {Object} db - OrbitDB KV database
 * @param {string} credentialId - base64url credential ID
 * @returns {Promise<Object|null>}
 */
export async function getDeviceByCredentialId(db, credentialId) {
  const key = await hashCredentialId(credentialId);
  return (await db.get(key)) || null;
}

/**
 * Look up a device by its Ed25519 DID.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did - Ed25519 DID (did:key:z6Mk...)
 * @returns {Promise<Object|null>}
 */
export async function getDeviceByDID(db, did) {
  const all = await db.all();
  const found = all.find((e) => e.value.ed25519_did === did);
  return found ? found.value : null;
}

/**
 * Grant write access to a new device DID via OrbitDBAccessController.
 * @param {Object} db - OrbitDB KV database (must use OrbitDBAccessController)
 * @param {string} did - Ed25519 DID of the new device
 */
export async function grantDeviceWriteAccess(db, did) {
  await db.access.grant('write', did);
}

/**
 * Revoke write access from a device DID and mark its registry entry as 'revoked'.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did - Ed25519 DID to revoke
 */
export async function revokeDeviceAccess(db, did) {
  await db.access.revoke('write', did);
  const entry = await getDeviceByDID(db, did);
  if (entry) {
    const key = await hashCredentialId(entry.credential_id);
    await db.put(key, { ...entry, status: 'revoked' });
  }
}

// ---------------------------------------------------------------------------
// UCAN delegation entries
// ---------------------------------------------------------------------------

/**
 * Store a UCAN delegation in the registry.
 * @param {Object} db - OrbitDB KV database
 * @param {string} delegationBase64 - raw delegation string
 * @param {string} [spaceDid] - Storacha space DID
 * @param {string} [label] - human-readable label
 */
export async function storeDelegationEntry(db, delegationBase64, spaceDid, label) {
  const hash = await hashCredentialId(delegationBase64);
  const key = `delegation:${hash}`;
  await db.put(key, {
    delegation: delegationBase64,
    space_did: spaceDid || '',
    label: label || 'default',
    created_at: Date.now(),
  });
}

/**
 * List all stored UCAN delegations.
 * @param {Object} db - OrbitDB KV database
 * @returns {Promise<Array>}
 */
export async function listDelegations(db) {
  const all = await db.all();
  return all.filter((e) => e.key?.startsWith?.('delegation:')).map((e) => e.value);
}

/**
 * Get a specific delegation by its base64 string.
 * @param {Object} db - OrbitDB KV database
 * @param {string} delegationBase64
 * @returns {Promise<Object|null>}
 */
export async function getDelegation(db, delegationBase64) {
  const hash = await hashCredentialId(delegationBase64);
  return (await db.get(`delegation:${hash}`)) || null;
}

/**
 * Remove a delegation from the registry.
 * @param {Object} db - OrbitDB KV database
 * @param {string} delegationBase64
 */
export async function removeDelegation(db, delegationBase64) {
  const hash = await hashCredentialId(delegationBase64);
  await db.del(`delegation:${hash}`);
}

// ---------------------------------------------------------------------------
// Encrypted Ed25519 archive entries
// ---------------------------------------------------------------------------

/**
 * Store an encrypted Ed25519 archive in the registry.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did - Ed25519 DID
 * @param {string} ciphertext - hex-encoded ciphertext
 * @param {string} iv - hex-encoded IV
 */
export async function storeArchiveEntry(db, did, ciphertext, iv) {
  await db.put(`archive:${did}`, {
    ciphertext,
    iv,
    did,
    created_at: Date.now(),
  });
}

/**
 * Get an encrypted archive entry by DID.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did
 * @returns {Promise<Object|null>}
 */
export async function getArchiveEntry(db, did) {
  return (await db.get(`archive:${did}`)) || null;
}

// ---------------------------------------------------------------------------
// Keypair metadata entries
// ---------------------------------------------------------------------------

/**
 * Store Ed25519 keypair metadata (no private key) in the registry.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did - Ed25519 DID
 * @param {string} publicKeyHex - hex-encoded public key
 */
export async function storeKeypairEntry(db, did, publicKeyHex) {
  await db.put(`keypair:${did}`, {
    publicKey: publicKeyHex,
    did,
    created_at: Date.now(),
  });
}

/**
 * Get keypair metadata by DID.
 * @param {Object} db - OrbitDB KV database
 * @param {string} did
 * @returns {Promise<Object|null>}
 */
export async function getKeypairEntry(db, did) {
  return (await db.get(`keypair:${did}`)) || null;
}

/**
 * List all stored keypair entries.
 * @param {Object} db - OrbitDB KV database
 * @returns {Promise<Array>}
 */
export async function listKeypairs(db) {
  const all = await db.all();
  return all.filter((e) => e.key?.startsWith?.('keypair:')).map((e) => e.value);
}
