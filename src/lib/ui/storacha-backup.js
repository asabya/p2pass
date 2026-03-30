/**
 * Storacha backup helpers: client bootstrap, space listing, usage summaries, and file listing.
 *
 * Decoupled from UI — callers pass Storacha credentials or an authenticated client. Uses `orbitdb-storacha-bridge` where applicable.
 *
 * @module ui/storacha-backup
 */

import { listStorachaSpaceFiles } from 'orbitdb-storacha-bridge';
import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import { Signer } from '@storacha/client/principal/ed25519';
import * as Proof from '@storacha/client/proof';
import * as Delegation from '@ucanto/core/delegation';

/**
 * Build a Storacha client from a stored principal key string and proof CAR/string.
 *
 * @param {string} storachaKey - Ed25519 principal key material (Signer.parse)
 * @param {string} storachaProof - Delegation / space proof string
 * @returns {Promise<import('@storacha/client').Client>}
 */
export async function initializeStorachaClient(storachaKey, storachaProof) {
  const principal = Signer.parse(storachaKey);
  const store = new StoreMemory();
  const client = await Client.create({ principal, store });

  const proof = await Proof.parse(storachaProof);
  const space = await client.addSpace(proof);
  await client.setCurrentSpace(space.did());

  return client;
}

/**
 * Build a Storacha client from a base64 UCAN token and JSON recipient key archive.
 *
 * @param {string} ucanToken - Base64-encoded delegation bytes
 * @param {string} recipientKey - JSON string describing recipient `Signer` material
 * @returns {Promise<import('@storacha/client').Client>}
 */
export async function initializeStorachaClientWithUCAN(ucanToken, recipientKey) {
  const recipientKeyData = JSON.parse(recipientKey);
  const fixedArchive = {
    id: recipientKeyData.id,
    keys: {
      [recipientKeyData.id]: new Uint8Array(
        Object.values(recipientKeyData.keys[recipientKeyData.id])
      ),
    },
  };

  const recipientPrincipal = Signer.from(fixedArchive);
  const store = new StoreMemory();
  const client = await Client.create({
    principal: recipientPrincipal,
    store,
  });

  const delegationBytes = Buffer.from(ucanToken, 'base64');
  const delegation = await Delegation.extract(delegationBytes);

  if (!delegation.ok) {
    throw new Error('Failed to extract delegation from token');
  }

  const space = await client.addSpace(delegation.ok);
  await client.setCurrentSpace(space.did());

  return client;
}

/**
 * List Storacha spaces visible to an authenticated client (current space first, then account spaces).
 *
 * @param {import('@storacha/client').Client} client
 * @returns {Promise<Array<{ did: string, name: string, registered: boolean, current?: boolean }>>}
 */
export async function listSpaces(client) {
  const currentSpace = client.currentSpace();
  if (currentSpace) {
    let registered;
    try {
      registered =
        typeof currentSpace.registered === 'function' ? currentSpace.registered() : false;
    } catch {
      registered = false;
    }

    return [
      {
        did: currentSpace.did(),
        name: currentSpace.name || 'Current Space',
        registered: registered,
        current: true,
      },
    ];
  }

  const accounts = client.accounts();
  if (accounts.length === 0) {
    return [];
  }

  const account = accounts[0];
  const spaces = [];
  for (const space of account.spaces()) {
    spaces.push({
      did: space.did(),
      name: space.name || 'Unnamed Space',
      registered: space.registered(),
    });
  }

  return spaces;
}

/**
 * Summarize upload activity in the current space (`upload/list` capability).
 *
 * @param {import('@storacha/client').Client} client
 * @param {boolean} [detailed=false] - When true, sample uploads to classify backup vs block CARs (bounded work)
 * @returns {Promise<object>} Totals, date range, and optional per-CID samples
 */
export async function getSpaceUsage(client, detailed = false) {
  const result = await client.capability.upload.list({ size: 1000 });
  const uploads = result.results || [];

  if (uploads.length === 0) {
    return {
      totalFiles: 0,
      lastUploadDate: null,
      oldestUploadDate: null,
      uploads: [],
      backupFiles: 0,
      blockFiles: 0,
      otherFiles: 0,
      analyzed: false,
    };
  }

  const sortedUploads = uploads.sort((a, b) => new Date(b.insertedAt) - new Date(a.insertedAt));
  const lastUploadDate = sortedUploads[0].insertedAt;
  const oldestUploadDate = sortedUploads[sortedUploads.length - 1].insertedAt;

  let backupFiles = 0;
  let blockFiles = 0;
  let otherFiles = 0;
  const processedUploads = [];

  if (detailed && uploads.length <= 50) {
    const samplesToAnalyze = uploads.slice(0, 20);

    for (const upload of samplesToAnalyze) {
      const cid = upload.root.toString();
      let fileType = 'block';

      try {
        const response = await fetch(`https://w3s.link/ipfs/${cid}`, {
          headers: { Range: 'bytes=0-512' },
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const text = await response.text();
          if (text.trim().startsWith('{') && text.includes('backupVersion')) {
            fileType = 'backup';
          }
        }
      } catch {
        // Keep default 'block' type
      }

      if (fileType === 'backup') backupFiles++;
      else if (fileType === 'block') blockFiles++;
      else otherFiles++;

      processedUploads.push({
        cid,
        uploadedAt: upload.insertedAt,
        size: upload.size || null,
        type: fileType,
      });
    }

    const remaining = uploads.length - samplesToAnalyze.length;
    if (remaining > 0) {
      blockFiles += remaining;
      for (let i = samplesToAnalyze.length; i < uploads.length; i++) {
        const upload = uploads[i];
        processedUploads.push({
          cid: upload.root.toString(),
          uploadedAt: upload.insertedAt,
          size: upload.size || null,
          type: 'block',
        });
      }
    }
  } else {
    blockFiles = uploads.length;
    for (const upload of uploads) {
      processedUploads.push({
        cid: upload.root.toString(),
        uploadedAt: upload.insertedAt,
        size: upload.size || null,
        type: 'unknown',
      });
    }
  }

  return {
    totalFiles: uploads.length,
    lastUploadDate,
    oldestUploadDate,
    uploads: processedUploads,
    backupFiles,
    blockFiles,
    otherFiles,
    analyzed: detailed && uploads.length <= 50,
  };
}

/**
 * List files in the Storacha space associated with the given key + proof (delegation).
 *
 * @param {string} storachaKey
 * @param {string} storachaProof
 * @returns {Promise<unknown>} Result shape from `orbitdb-storacha-bridge` `listStorachaSpaceFiles`
 */
export async function listStorachaFiles(storachaKey, storachaProof) {
  const spaceFiles = await listStorachaSpaceFiles({
    storachaKey,
    storachaProof,
    size: 1000,
  });

  return spaceFiles;
}
