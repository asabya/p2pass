/**
 * Identity service — orchestrates WebAuthn passkey auth with auto mode detection.
 * Combines hardware signer and worker Ed25519 flows.
 */

import {
	WebAuthnHardwareSignerService,
	storeWebAuthnCredentialSafe,
	loadWebAuthnCredentialSafe,
	extractPrfSeedFromCredential,
	initEd25519KeystoreWithPrfSeed,
	generateWorkerEd25519DID,
	loadWorkerEd25519Archive,
	encryptArchive,
	decryptArchive
} from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';

import { detectSigningMode, getStoredSigningMode } from './mode-detector.js';

const STORAGE_KEYS = {
	WEBAUTHN_CREDENTIAL: 'webauthn_credential_info',
	ED25519_KEYPAIR: 'ed25519_keypair',
	ED25519_ARCHIVE_ENCRYPTED: 'ed25519_archive_encrypted'
};

export class IdentityService {
	#mode = null;
	#did = null;
	#algorithm = null;
	#signer = null;
	#hardwareService = null;
	#archive = null;

	constructor() {
		this.#hardwareService = new WebAuthnHardwareSignerService();
	}

	/**
	 * Initialize identity — auto-detect hardware vs worker mode.
	 * If existing credentials found, restores them (may prompt biometric for worker PRF).
	 * If no credentials, creates new passkey.
	 *
	 * @param {'platform'|'cross-platform'} [authenticatorType]
	 * @returns {Promise<{ mode: string, did: string, algorithm: string }>}
	 */
	async initialize(authenticatorType) {
		console.log('IdentityService: initializing...');

		// Try hardware mode first
		try {
			const signer = await this.#hardwareService.initialize({
				authenticatorType,
				preferEd25519: true
			});

			if (signer) {
				this.#mode = 'hardware';
				this.#did = this.#hardwareService.getDID();
				this.#algorithm = this.#hardwareService.getAlgorithm() || 'Ed25519';
				this.#signer = signer;
				console.log(`IdentityService: hardware mode (${this.#algorithm}), DID: ${this.#did}`);
				return this.getSigningMode();
			}
		} catch (err) {
			console.warn('IdentityService: hardware mode failed, trying worker...', err.message);
		}

		// Worker mode — try to restore existing keypair
		const restored = await this.#tryRestoreWorkerIdentity();
		if (restored) {
			console.log(`IdentityService: restored worker identity, DID: ${this.#did}`);
			return this.getSigningMode();
		}

		// No existing identity — create new worker identity
		await this.#createWorkerIdentity(authenticatorType);
		console.log(`IdentityService: created new worker identity, DID: ${this.#did}`);
		return this.getSigningMode();
	}

	/**
	 * Force create a new identity (discards existing).
	 * @param {'platform'|'cross-platform'} [authenticatorType]
	 * @returns {Promise<{ mode: string, did: string, algorithm: string }>}
	 */
	async createNewIdentity(authenticatorType) {
		this.#clearWorkerStorage();
		this.#hardwareService.clear();
		this.#mode = null;
		this.#did = null;
		this.#signer = null;
		this.#archive = null;

		return this.initialize(authenticatorType);
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
			secure: this.#mode === 'hardware'
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
	 * Try to restore a worker identity from localStorage.
	 * Requires WebAuthn re-auth to get PRF seed for archive decryption.
	 */
	async #tryRestoreWorkerIdentity() {
		try {
			const keypairStr = localStorage.getItem(STORAGE_KEYS.ED25519_KEYPAIR);
			const archiveStr = localStorage.getItem(STORAGE_KEYS.ED25519_ARCHIVE_ENCRYPTED);

			if (!keypairStr || !archiveStr) return false;

			const keypair = JSON.parse(keypairStr);
			const encryptedArchive = JSON.parse(archiveStr);

			// Need PRF seed to decrypt — requires WebAuthn re-auth
			const credential = loadWebAuthnCredentialSafe();
			if (!credential) {
				console.warn('IdentityService: stored keypair but no WebAuthn credential');
				return false;
			}

			console.log('IdentityService: restoring worker identity (biometric required)...');
			const { seed: prfSeed } = await extractPrfSeedFromCredential(credential);

			// Init worker keystore with PRF
			await initEd25519KeystoreWithPrfSeed(prfSeed);

			// Decrypt archive
			const ciphertext = hexToBytes(encryptedArchive.ciphertext);
			const iv = hexToBytes(encryptedArchive.iv);
			const archive = await decryptArchive(ciphertext, iv);

			// Load archive into worker
			await loadWorkerEd25519Archive(archive);

			this.#mode = 'worker';
			this.#did = keypair.did;
			this.#algorithm = 'Ed25519';
			this.#archive = archive;

			return true;
		} catch (err) {
			console.warn('IdentityService: failed to restore worker identity:', err.message);
			return false;
		}
	}

	/**
	 * Create a new worker-mode Ed25519 identity.
	 */
	async #createWorkerIdentity(authenticatorType) {
		// Create WebAuthn credential with PRF
		const credential = await this.#createWebAuthnCredential(authenticatorType);

		// Extract PRF seed
		const { seed: prfSeed } = await extractPrfSeedFromCredential(credential);

		// Init worker with PRF seed
		await initEd25519KeystoreWithPrfSeed(prfSeed);

		// Generate Ed25519 DID in worker
		const { publicKey, did, archive } = await generateWorkerEd25519DID();

		// Encrypt archive for storage
		const { ciphertext, iv } = await encryptArchive(archive);

		// Store keypair info (no private key)
		localStorage.setItem(STORAGE_KEYS.ED25519_KEYPAIR, JSON.stringify({
			publicKey: bytesToHex(publicKey),
			privateKey: '',
			did
		}));

		// Store encrypted archive
		localStorage.setItem(STORAGE_KEYS.ED25519_ARCHIVE_ENCRYPTED, JSON.stringify({
			ciphertext: bytesToHex(ciphertext),
			iv: bytesToHex(iv)
		}));

		// Store WebAuthn credential (without PRF seed)
		storeWebAuthnCredentialSafe(credential);

		this.#mode = 'worker';
		this.#did = did;
		this.#algorithm = 'Ed25519';
		this.#archive = archive;
	}

	/**
	 * Create a WebAuthn credential with PRF extension.
	 */
	async #createWebAuthnCredential(authenticatorType) {
		const challenge = crypto.getRandomValues(new Uint8Array(32));
		const prfSalt = crypto.getRandomValues(new Uint8Array(32));

		const createOptions = {
			publicKey: {
				rp: {
					name: 'P2P Passkeys',
					id: globalThis.location?.hostname || 'localhost'
				},
				user: {
					id: crypto.getRandomValues(new Uint8Array(16)),
					name: 'p2p-user',
					displayName: 'P2P User'
				},
				challenge,
				pubKeyCredParams: [
					{ type: 'public-key', alg: -7 },   // ES256 (P-256)
					{ type: 'public-key', alg: -257 }   // RS256
				],
				authenticatorSelection: {
					authenticatorAttachment: authenticatorType || 'platform',
					residentKey: 'required',
					userVerification: 'preferred'
				},
				extensions: {
					prf: { eval: { first: prfSalt } }
				}
			}
		};

		const credential = await navigator.credentials.create(createOptions);

		// Attach metadata for storage
		credential._prfInput = prfSalt;
		credential._rawCredentialId = new Uint8Array(credential.rawId);

		return credential;
	}

	#clearWorkerStorage() {
		Object.values(STORAGE_KEYS).forEach(key => {
			try { localStorage.removeItem(key); } catch { /* ignore */ }
		});
	}
}

function bytesToHex(bytes) {
	return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
	}
	return bytes;
}
