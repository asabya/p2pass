/**
 * Signing mode detection — auto-detects hardware vs worker WebAuthn mode.
 * Ported from ucan-upload-wall's ucan-delegation.ts mode detection logic.
 */

import {
  WebAuthnHardwareSignerService,
  checkEd25519Support,
  getStoredWebAuthnHardwareSignerInfo,
} from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';

import { listKeypairs } from '../registry/device-registry.js';

/**
 * Detect the best available signing mode.
 * Priority: hardware Ed25519 > hardware P-256 > stored worker keypair > null (needs setup)
 *
 * @param {{ authenticatorType?: 'platform'|'cross-platform', forceWorker?: boolean, registryDb?: Object }} options
 * @returns {Promise<{ mode: 'hardware'|'worker'|null, signer?: any, did?: string, algorithm?: string }>}
 */
export async function detectSigningMode(options = {}) {
  const { forceWorker = false, registryDb } = options;

  // Check for stored mode first (fast path, no biometric)
  const stored = await getStoredSigningMode(registryDb);
  if (stored.mode) {
    console.log(`Stored signing mode found: ${stored.mode} (${stored.algorithm})`);
    return stored;
  }

  // Try hardware mode unless forced to worker
  if (!forceWorker) {
    try {
      const hardwareResult = await tryHardwareMode(options);
      if (hardwareResult) {
        console.log(`Hardware mode initialized: ${hardwareResult.algorithm}`);
        return hardwareResult;
      }
    } catch (err) {
      console.warn('Hardware mode detection failed:', err.message);
    }
  }

  // No stored mode and hardware failed — needs setup
  return { mode: null };
}

/**
 * Get stored signing mode info without requiring biometric auth.
 * Checks registry DB first if provided, then falls back to hardware signer storage.
 *
 * @param {Object} [registryDb] - OrbitDB registry database
 * @returns {Promise<{ mode: 'hardware'|'worker'|null, did?: string, algorithm?: string }>}
 */
export async function getStoredSigningMode(registryDb) {
  // Check hardware signer storage
  try {
    const hardwareInfo = getStoredWebAuthnHardwareSignerInfo();
    if (hardwareInfo && hardwareInfo.did) {
      return {
        mode: 'hardware',
        did: hardwareInfo.did,
        algorithm: hardwareInfo.algorithm || 'Ed25519',
      };
    }
  } catch {
    // No stored hardware signer
  }

  // Check registry DB for worker keypairs
  if (registryDb) {
    try {
      const keypairs = await listKeypairs(registryDb);
      if (keypairs.length > 0 && keypairs[0].did) {
        return {
          mode: 'worker',
          did: keypairs[0].did,
          algorithm: 'Ed25519',
        };
      }
    } catch {
      // Registry read failed
    }
  }

  return { mode: null };
}

/**
 * Try to initialize hardware signing mode.
 * @returns {Promise<{ mode: 'hardware', signer: any, did: string, algorithm: string }|null>}
 */
async function tryHardwareMode(options = {}) {
  const { authenticatorType } = options;

  // Check browser support
  const ed25519Supported = await checkEd25519Support();
  console.log(`Ed25519 hardware support: ${ed25519Supported}`);

  const service = new WebAuthnHardwareSignerService();

  try {
    const signer = await service.initialize({
      authenticatorType,
      preferEd25519: true,
    });

    if (signer) {
      const did = service.getDID();
      const algorithm = service.getAlgorithm() || 'Ed25519';

      return {
        mode: 'hardware',
        signer,
        did,
        algorithm,
      };
    }
  } catch (err) {
    console.warn('Hardware signer initialization failed:', err.message);
  }

  return null;
}
