/**
 * Identity service — orchestrates WebAuthn passkey auth with auto mode detection.
 * Combines hardware signer and worker Ed25519 flows.
 *
 * Credential data is stored in an OrbitDB registry DB when available.
 * Falls back to in-memory storage until setRegistry() is called.
 */

import {
  WebAuthnHardwareSignerService,
  loadWebAuthnCredentialSafe,
  getStoredWebAuthnHardwareSignerInfo,
  extractPrfSeedFromCredential,
  initEd25519KeystoreWithPrfSeed,
  generateWorkerEd25519DID,
  loadWorkerEd25519Archive,
  encryptArchive,
  decryptArchive,
} from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';

import {
  storeKeypairEntry,
  storeArchiveEntry,
  getArchiveEntry,
  listKeypairs,
} from '../registry/device-registry.js';

import {
  computeDeterministicPrfSalt,
  deriveIPNSKeyPair,
  recoverPrfSeed,
} from '../recovery/ipns-key.js';

import { resolveSigningPreference } from './signing-preference.js';

const ARCHIVE_CACHE_KEY = 'p2p_passkeys_worker_archive';

/** WebAuthn user.id must be at most 64 bytes (UTF-8). */
const WEBAUTHN_USER_ID_MAX_BYTES = 64;

/**
 * Build {@link https://www.w3.org/TR/webauthn-3/#dictdef-publickeycredentialuserentity PublicKeyCredentialUserEntity}.
 * Empty label keeps prior defaults (random opaque user.id).
 *
 * @param {string} label
 * @returns {Promise<{ id: Uint8Array, name: string, displayName: string }>}
 */
async function publicKeyCredentialUserFromLabel(label) {
  const trimmed = (typeof label === 'string' ? label : '').trim();
  if (!trimmed) {
    return {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: 'p2p-user',
      displayName: 'P2P User',
    };
  }
  const encoder = new TextEncoder();
  let idBytes = encoder.encode(trimmed);
  if (idBytes.length > WEBAUTHN_USER_ID_MAX_BYTES) {
    const digest = await crypto.subtle.digest('SHA-256', idBytes);
    idBytes = new Uint8Array(digest);
  }
  return {
    id: idBytes,
    name: trimmed,
    displayName: trimmed,
  };
}

/**
 * Best-effort: this origin likely already has passkey / identity material (no WebAuthn prompt).
 * Uses the same signals as restore paths — false negatives are OK (same handlers still apply).
 *
 * @returns {boolean}
 */
export function hasLocalPasskeyHint() {
  if (typeof globalThis.localStorage === 'undefined') return false;
  try {
    const hw = getStoredWebAuthnHardwareSignerInfo();
    if (hw?.did) return true;
  } catch {
    /* ignore */
  }
  try {
    if (loadWebAuthnCredentialSafe()) return true;
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(ARCHIVE_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.did || parsed.ciphertext)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export class IdentityService {
  #mode = null;
  #did = null;
  #algorithm = null;
  #signer = null;
  #hardwareService = null;
  #archive = null;
  #registryDb = null;

  // Hold credentials in memory until registry DB is available
  #pendingCredentials = null;
  #prfSeed = null;
  #ipnsKeyPair = null;

  constructor() {
    this.#hardwareService = new WebAuthnHardwareSignerService();
  }

  /**
   * Bind an OrbitDB registry database for credential storage.
   * If pending credentials exist from a prior initialize() call, flushes them.
   *
   * @param {Object} db - OrbitDB KeyValue database (from openDeviceRegistry)
   */
  async setRegistry(db) {
    this.#registryDb = db;
    console.log('[identity] Registry DB bound');

    // Flush pending credentials to registry
    if (this.#pendingCredentials) {
      const { publicKeyHex, did, ciphertext, iv } = this.#pendingCredentials;
      await storeKeypairEntry(db, did, publicKeyHex);
      await storeArchiveEntry(db, did, ciphertext, iv);
      console.log('[identity] Flushed pending credentials to registry DB');
      this.#pendingCredentials = null;
    }
  }

  /**
   * Get the bound registry DB (or null).
   * @returns {Object|null}
   */
  getRegistry() {
    return this.#registryDb;
  }

  /**
   * Initialize identity — auto-detect hardware vs worker mode.
   * If existing credentials found, restores them (may prompt biometric for worker PRF).
   * If no credentials, creates new passkey.
   *
   * @param {'platform'|'cross-platform'} [authenticatorType]
   * @param {{ preferWorkerMode?: boolean, signingPreference?: import('./signing-preference.js').SigningPreference, webauthnUserLabel?: string }} [options]
   * @returns {Promise<{ mode: string, did: string, algorithm: string }>}
   */
  async initialize(authenticatorType, options = {}) {
    const { preferWorkerMode = false, signingPreference = null, webauthnUserLabel = '' } = options;
    const pref = resolveSigningPreference({ preferWorkerMode, signingPreference });
    const preferWorker = pref === 'worker';
    const forceP256Hardware = pref === 'hardware-p256';

    console.log(
      '[identity] Initializing...',
      preferWorker ? '(worker)' : `(hardware, forceP256=${forceP256Hardware})`
    );

    // Try hardware mode first (unless worker mode is selected)
    if (!preferWorker) {
      try {
        const trimmedLabel = webauthnUserLabel.trim();
        const hwOpts = {
          authenticatorType,
          forceP256: forceP256Hardware,
        };
        if (trimmedLabel) {
          hwOpts.userId = trimmedLabel;
          hwOpts.displayName = trimmedLabel;
        }
        const signer = await this.#hardwareService.initialize(hwOpts);

        if (signer) {
          this.#mode = 'hardware';
          this.#did = this.#hardwareService.getDID();
          this.#algorithm = this.#hardwareService.getAlgorithm() || 'Ed25519';
          this.#signer = signer;
          console.log(`[identity] Hardware mode (${this.#algorithm}), DID: ${this.#did}`);
          return this.getSigningMode();
        }
      } catch (err) {
        console.warn('[identity] Hardware mode failed, trying worker...', err.message);
      }
    }

    // Worker mode — try to restore existing identity
    const restored = await this.#tryRestoreWorkerIdentity();
    if (restored) {
      console.log(`[identity] Restored worker identity, DID: ${this.#did}`);
      return this.getSigningMode();
    }

    // No existing identity — create new worker identity
    await this.#createWorkerIdentity(authenticatorType, webauthnUserLabel);
    console.log(`[identity] Created new worker identity, DID: ${this.#did}`);
    return this.getSigningMode();
  }

  /**
   * Force create a new identity (discards existing).
   * @param {'platform'|'cross-platform'} [authenticatorType]
   * @param {{ preferWorkerMode?: boolean, signingPreference?: import('./signing-preference.js').SigningPreference, webauthnUserLabel?: string }} [options]
   * @returns {Promise<{ mode: string, did: string, algorithm: string }>}
   */
  async createNewIdentity(authenticatorType, options = {}) {
    this.#hardwareService.clear();
    this.#mode = null;
    this.#did = null;
    this.#signer = null;
    this.#archive = null;
    this.#pendingCredentials = null;

    return this.initialize(authenticatorType, options);
  }

  /**
   * Recovery entry point — uses discoverable credentials to derive IPNS key.
   * Does NOT restore the DID — caller must resolve manifest and restore registry first.
   * @returns {Promise<{ prfSeed: Uint8Array, ipnsKeyPair: Object, rawCredentialId: Uint8Array }>}
   */
  async initializeFromRecovery() {
    console.log('[identity] Starting recovery via discoverable credential...');
    const { prfSeed, rawCredentialId } = await recoverPrfSeed();

    this.#prfSeed = prfSeed;
    this.#ipnsKeyPair = await deriveIPNSKeyPair(prfSeed);

    console.log('[identity] Recovery: IPNS keypair derived');
    return { prfSeed, ipnsKeyPair: this.#ipnsKeyPair, rawCredentialId };
  }

  /**
   * Restore DID from an encrypted archive entry (from registry DB after recovery).
   * Uses the PRF seed stored during initializeFromRecovery().
   * @param {Object} archiveEntry - { ciphertext: string (hex), iv: string (hex) }
   * @param {string} did - The owner DID from the manifest
   * @returns {Promise<void>}
   */
  async restoreFromManifest(archiveEntry, did) {
    if (!this.#prfSeed) {
      throw new Error('No PRF seed available. Call initializeFromRecovery() first.');
    }

    console.log('[identity] Restoring DID from manifest + registry archive...');

    // Init worker keystore with PRF
    await initEd25519KeystoreWithPrfSeed(this.#prfSeed);

    // Decrypt archive
    const ciphertext = hexToBytes(archiveEntry.ciphertext);
    const iv = hexToBytes(archiveEntry.iv);
    const archive = await decryptArchive(ciphertext, iv);

    // Load archive into worker
    await loadWorkerEd25519Archive(archive);

    this.#mode = 'worker';
    this.#did = did;
    this.#algorithm = 'Ed25519';
    this.#archive = archive;

    console.log(`[identity] DID restored from manifest: ${did}`);
  }

  /**
   * Get current signing mode info.
   * @returns {{ mode: string|null, did: string|null, algorithm: string|null, secure: boolean }}
   */
  getSigningMode() {
    return {
      mode: this.#mode,
      did: this.#did,
      algorithm: this.#algorithm,
      secure: this.#mode === 'hardware',
    };
  }

  /**
   * Get a UCAN-compatible principal/signer.
   * For hardware mode: returns varsig signer via toUcantoSigner()
   * For worker mode: returns Ed25519 principal from archive
   *
   * @returns {Promise<any>} UCAN signer
   */
  async getPrincipal() {
    if (this.#mode === 'hardware' && this.#signer) {
      return this.#signer.toUcantoSigner();
    }

    if (this.#mode === 'worker' && this.#archive) {
      const { from } = await import('@ucanto/principal/ed25519');
      return from(this.#archive);
    }

    throw new Error('No identity initialized. Call initialize() first.');
  }

  /**
   * @returns {boolean}
   */
  isInitialized() {
    return this.#mode !== null && this.#did !== null;
  }

  /**
   * Get the derived IPNS keypair (available after initialize or recovery).
   * @returns {{ privateKey: Object, publicKey: Object }|null}
   */
  getIPNSKeyPair() {
    return this.#ipnsKeyPair;
  }

  /**
   * Get the stored PRF seed (available after initialize or recovery).
   * @returns {Uint8Array|null}
   */
  getPrfSeed() {
    return this.#prfSeed;
  }

  /**
   * Get the encrypted archive data (ciphertext + iv as hex strings) for the current identity.
   * Used by manifest publishing to upload the archive to IPFS for auth-free recovery.
   *
   * @returns {Promise<{ ciphertext: string, iv: string }|null>}
   */
  async getEncryptedArchiveData() {
    if (!this.#did) return null;

    // From pending credentials (not yet flushed to registry)
    if (this.#pendingCredentials) {
      return { ciphertext: this.#pendingCredentials.ciphertext, iv: this.#pendingCredentials.iv };
    }

    // From registry DB
    if (this.#registryDb) {
      const entry = await getArchiveEntry(this.#registryDb, this.#did);
      if (entry) return { ciphertext: entry.ciphertext, iv: entry.iv };
    }

    // From localStorage cache
    const cached = this.#loadCachedArchive();
    if (cached && cached.did === this.#did) {
      return { ciphertext: cached.ciphertext, iv: cached.iv };
    }

    return null;
  }

  /**
   * Try to restore a worker identity.
   * Checks registry DB first, falls back to in-memory pending credentials.
   * Requires WebAuthn re-auth to get PRF seed for archive decryption.
   */
  async #tryRestoreWorkerIdentity() {
    try {
      // Try registry DB first
      if (this.#registryDb) {
        const keypairs = await listKeypairs(this.#registryDb);
        if (keypairs.length > 0) {
          const keypair = keypairs[0]; // use first keypair
          const archiveEntry = await getArchiveEntry(this.#registryDb, keypair.did);

          if (archiveEntry) {
            return await this.#restoreFromEncryptedArchive(keypair, archiveEntry);
          }
        }
      }

      // Fallback: try localStorage cache (bootstrap before registry is available)
      const cached = this.#loadCachedArchive();
      if (cached) {
        const credential = loadWebAuthnCredentialSafe();
        if (credential) {
          console.log('[identity] Found cached archive, attempting restore via biometric...');
          return await this.#restoreFromEncryptedArchive(
            { did: cached.did, publicKey: cached.publicKeyHex },
            { ciphertext: cached.ciphertext, iv: cached.iv }
          );
        }
      }

      return false;
    } catch (err) {
      console.warn('[identity] Failed to restore worker identity:', err.message);
      return false;
    }
  }

  /**
   * Restore worker identity from encrypted archive data.
   * @param {Object} keypair - { did, publicKey }
   * @param {Object} archiveEntry - { ciphertext, iv }
   * @returns {Promise<boolean>}
   */
  async #restoreFromEncryptedArchive(keypair, archiveEntry) {
    // Need PRF seed to decrypt — requires WebAuthn re-auth
    const credential = loadWebAuthnCredentialSafe();
    if (!credential) {
      console.warn('[identity] Stored keypair but no WebAuthn credential for PRF');
      return false;
    }

    console.log('[identity] Restoring worker identity (biometric required)...');
    const { seed: prfSeed } = await extractPrfSeedFromCredential(credential);

    // Store PRF seed and derive IPNS keypair
    this.#prfSeed = prfSeed;
    try {
      this.#ipnsKeyPair = await deriveIPNSKeyPair(prfSeed);
      console.log('[identity] IPNS keypair derived (restore)');
    } catch (err) {
      console.warn('[identity] Failed to derive IPNS keypair:', err.message);
    }

    // Init worker keystore with PRF
    await initEd25519KeystoreWithPrfSeed(prfSeed);

    // Decrypt archive
    const ciphertext = hexToBytes(archiveEntry.ciphertext);
    const iv = hexToBytes(archiveEntry.iv);
    const archive = await decryptArchive(ciphertext, iv);

    // Load archive into worker
    await loadWorkerEd25519Archive(archive);

    this.#mode = 'worker';
    this.#did = keypair.did;
    this.#algorithm = 'Ed25519';
    this.#archive = archive;

    return true;
  }

  #loadCachedArchive() {
    try {
      const raw = localStorage.getItem(ARCHIVE_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Create a new worker-mode Ed25519 identity.
   */
  async #createWorkerIdentity(authenticatorType, webauthnUserLabel) {
    // Create WebAuthn credential with PRF
    const credential = await this.#createWebAuthnCredential(authenticatorType, webauthnUserLabel);

    // Extract PRF seed
    const { seed: prfSeed } = await extractPrfSeedFromCredential(credential);

    // Store PRF seed and derive IPNS keypair
    this.#prfSeed = prfSeed;
    try {
      this.#ipnsKeyPair = await deriveIPNSKeyPair(prfSeed);
      console.log('[identity] IPNS keypair derived');
    } catch (err) {
      console.warn('[identity] Failed to derive IPNS keypair:', err.message);
    }

    // Init worker with PRF seed
    await initEd25519KeystoreWithPrfSeed(prfSeed);

    // Generate Ed25519 DID in worker
    const { publicKey, did, archive } = await generateWorkerEd25519DID();

    // Encrypt archive for storage
    const { ciphertext, iv } = await encryptArchive(archive);

    const publicKeyHex = bytesToHex(publicKey);
    const ciphertextHex = bytesToHex(ciphertext);
    const ivHex = bytesToHex(iv);

    // Store in registry DB if available, otherwise hold in memory
    if (this.#registryDb) {
      await storeKeypairEntry(this.#registryDb, did, publicKeyHex);
      await storeArchiveEntry(this.#registryDb, did, ciphertextHex, ivHex);
      console.log('[identity] Credentials stored in registry DB');
    } else {
      this.#pendingCredentials = {
        publicKeyHex,
        did,
        ciphertext: ciphertextHex,
        iv: ivHex,
      };
      console.log('[identity] Credentials held in memory (registry not yet bound)');
    }

    this.#mode = 'worker';
    this.#did = did;
    this.#algorithm = 'Ed25519';
    this.#archive = archive;
  }

  /**
   * Create a WebAuthn credential with PRF extension.
   */
  async #createWebAuthnCredential(authenticatorType, webauthnUserLabel) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const prfSalt = await computeDeterministicPrfSalt();
    const userEntity = await publicKeyCredentialUserFromLabel(webauthnUserLabel);

    const createOptions = {
      publicKey: {
        rp: {
          name: 'P2P Passkeys',
          id: globalThis.location?.hostname || 'localhost',
        },
        user: {
          id: userEntity.id,
          name: userEntity.name,
          displayName: userEntity.displayName,
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256 (P-256)
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: authenticatorType || 'platform',
          residentKey: 'required',
          userVerification: 'preferred',
        },
        extensions: {
          prf: { eval: { first: prfSalt } },
        },
      },
    };

    const credential = await navigator.credentials.create(createOptions);

    // Attach metadata for storage
    credential.prfInput = prfSalt;
    credential.rawCredentialId = new Uint8Array(credential.rawId);

    return credential;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
