/**
 * IPNS manifest publishing and resolution via Storacha w3name.
 *
 * A recovery manifest is a small JSON document pinned on IPFS (via Storacha)
 * and pointed to by a deterministic IPNS name derived from the user's PRF
 * seed. It contains enough information to locate and restore the user's
 * OrbitDB registry from any device.
 *
 * @module recovery/manifest
 */

import * as W3Name from 'w3name';

const PREFIX = '[recovery]';

/** Gateway URL template for fetching IPFS content */
const GATEWAY = 'https://{cid}.ipfs.w3s.link/';

/** localStorage key for persisting the latest IPNS revision */
const REVISION_KEY = 'p2p_passkeys_ipns_revision';

/** Fetch timeout for gateway requests (ms) */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} Manifest
 * @property {number} version - schema version (currently 1)
 * @property {string} registryAddress - OrbitDB address, e.g. "/orbitdb/zdpu..."
 * @property {string} delegation - base64-encoded UCAN delegation
 * @property {string} ownerDid - owner DID, e.g. "did:key:z6Mk..."
 * @property {string|null} [archiveCID] - CID of encrypted archive on IPFS (for auth-free recovery)
 * @property {number} updatedAt - unix epoch ms
 */

/**
 * Create a manifest object.
 *
 * Pure function — no side effects.
 *
 * @param {object} params
 * @param {string} params.registryAddress
 * @param {string} params.delegation
 * @param {string} params.ownerDid
 * @param {string} [params.archiveCID] - CID of encrypted archive on IPFS
 * @returns {Manifest}
 */
export function createManifest({ registryAddress, delegation, ownerDid, archiveCID }) {
  return {
    version: 1,
    registryAddress,
    delegation,
    ownerDid,
    archiveCID: archiveCID || null,
    updatedAt: Date.now(),
  };
}

/**
 * Upload an encrypted archive to IPFS via Storacha.
 * The archive is stored as a JSON blob accessible via public gateway
 * without authentication.
 *
 * @param {object} storachaClient - Storacha client with `uploadFile`
 * @param {{ ciphertext: string, iv: string }} archiveData - hex-encoded
 * @returns {Promise<string>} CID string
 */
export async function uploadArchiveToIPFS(storachaClient, archiveData) {
  const blob = new Blob(
    [JSON.stringify({ ciphertext: archiveData.ciphertext, iv: archiveData.iv })],
    { type: 'application/json' }
  );
  const cid = await storachaClient.uploadFile(blob);
  console.log(PREFIX, 'Encrypted archive uploaded to IPFS:', cid.toString());
  return cid.toString();
}

/**
 * Fetch an encrypted archive from the IPFS gateway (no auth needed).
 *
 * @param {string} cid - IPFS CID of the archive JSON
 * @returns {Promise<{ ciphertext: string, iv: string }|null>}
 */
export async function fetchArchiveFromIPFS(cid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = GATEWAY.replace('{cid}', cid);
    console.log(PREFIX, 'Fetching encrypted archive from gateway:', cid);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.log(PREFIX, `Gateway returned ${res.status} for archive CID ${cid}`);
      return null;
    }
    const data = await res.json();
    if (!data.ciphertext || !data.iv) {
      console.log(PREFIX, 'Invalid archive format — missing ciphertext or iv');
      return null;
    }
    return data;
  } catch (err) {
    console.log(PREFIX, 'Failed to fetch archive from gateway:', err?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish a manifest to IPFS (via Storacha) and point an IPNS name at it.
 *
 * If an existing IPNS record is found, the revision sequence is incremented.
 * Otherwise a new v0 revision is created. The encoded revision is persisted
 * in localStorage so subsequent publishes can increment correctly.
 *
 * @param {object} storachaClient - Storacha storage client with `uploadFile`
 * @param {object} ipnsPrivateKey - libp2p Ed25519 private key (from deriveIPNSKeyPair)
 * @param {Manifest} manifest
 * @returns {Promise<{ nameString: string, manifestCID: string }>}
 */
export async function publishManifest(storachaClient, ipnsPrivateKey, manifest) {
  // 1. Derive the WritableName from the raw key bytes
  const name = await W3Name.from(ipnsPrivateKey.raw);

  // 2. Upload the manifest JSON to Storacha
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  const cid = await storachaClient.uploadFile(manifestBlob);

  // 3. Build the IPNS value pointing at the uploaded CID
  const value = `/ipfs/${cid.toString()}`;

  // 4. Create or increment the IPNS revision
  let revision;
  try {
    const current = await W3Name.resolve(name);
    revision = await W3Name.increment(current, value);
  } catch {
    // No existing record — create the initial revision
    revision = await W3Name.v0(name, value);
  }

  // 5. Publish the revision
  await W3Name.publish(revision, name.key);

  // 6. Persist the revision locally for future increments
  try {
    const encoded = W3Name.Revision.encode(revision);
    localStorage.setItem(REVISION_KEY, JSON.stringify(Array.from(encoded)));
  } catch {
    console.log(PREFIX, 'Could not persist IPNS revision to localStorage');
  }

  console.log(PREFIX, `Published manifest to w3name: ${name.toString()}`);

  return {
    nameString: name.toString(),
    manifestCID: cid.toString(),
  };
}

/**
 * Resolve a manifest from w3name using the IPNS private key.
 *
 * @param {object} ipnsPrivateKey - libp2p Ed25519 private key (from deriveIPNSKeyPair)
 * @returns {Promise<Manifest|null>} parsed manifest, or null on failure
 */
export async function resolveManifest(ipnsPrivateKey) {
  try {
    const name = await W3Name.from(ipnsPrivateKey.raw);
    console.log(PREFIX, `Resolving manifest from w3name: ${name.toString()}`);
    return await fetchManifestForName(name);
  } catch (err) {
    console.log(PREFIX, 'Failed to resolve manifest:', err?.message ?? err);
    return null;
  }
}

/**
 * Resolve a manifest by its w3name string (read-only, no private key needed).
 *
 * @param {string} nameString - w3name identifier, e.g. "k51qzi5uqu5di..."
 * @returns {Promise<Manifest|null>} parsed manifest, or null on failure
 */
export async function resolveManifestByName(nameString) {
  try {
    const name = W3Name.parse(nameString);
    console.log(PREFIX, `Resolving manifest from w3name: ${nameString}`);
    return await fetchManifestForName(name);
  } catch (err) {
    console.log(PREFIX, 'Failed to resolve manifest by name:', err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the IPNS name, fetch the manifest from the IPFS gateway, and
 * validate the basic structure.
 *
 * @param {object} name - W3Name Name object (writable or read-only)
 * @returns {Promise<Manifest|null>}
 * @private
 */
async function fetchManifestForName(name) {
  // Resolve the IPNS record to get the /ipfs/... value
  const revision = await W3Name.resolve(name);
  const ipfsPath = revision.value; // e.g. "/ipfs/bafyabc..."

  // Extract the CID from the path
  const cid = ipfsPath.replace(/^\/ipfs\//, '');
  if (!cid) {
    console.log(PREFIX, 'Resolved IPNS value has no CID:', ipfsPath);
    return null;
  }

  // Fetch the manifest from the Storacha/IPFS gateway with a timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = GATEWAY.replace('{cid}', cid);
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      console.log(PREFIX, `Gateway returned ${res.status} for CID ${cid}`);
      return null;
    }

    const manifest = await res.json();

    // Basic validation
    if (!manifest.version || !manifest.registryAddress) {
      console.log(PREFIX, 'Invalid manifest schema — missing version or registryAddress');
      return null;
    }

    return manifest;
  } finally {
    clearTimeout(timer);
  }
}
