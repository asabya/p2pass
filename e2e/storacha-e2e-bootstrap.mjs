/**
 * Starts the same in-memory Storacha stack as ucan-upload-wall (upload-api test context + HTTP server)
 * plus a tiny helper HTTP server to mint a UCAN delegation for any audience DID (for Playwright).
 *
 * @module e2e/storacha-e2e-bootstrap
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed25519 from '@ucanto/principal/ed25519';
import { delegate } from '@ucanto/core';
import * as ProviderCaps from '@storacha/capabilities/provider';
import * as DidMailto from '@storacha/did-mailto';
import { Absentee } from '@ucanto/principal';
import {
  loadUploadApiTestContext,
  createCorsHttp,
  refreshExternalServiceProofs,
  startUploadApiServer,
} from './local-storacha-api/upload-service.mjs';

const e2eDir = dirname(fileURLToPath(import.meta.url));

/** @type {null | { cleanupContext: Function, uploadServiceContext: object, uploadApiServer: import('http').Server, helperServer: import('http').Server, space: Awaited<ReturnType<typeof ed25519.generate>> }} */
let state = null;

/**
 * @param {Awaited<ReturnType<typeof ed25519.generate>>} space
 */
function buildDelegationCapabilities(space) {
  return [
    { with: space.did(), can: 'assert/index' },
    { with: space.did(), can: 'space/blob/add' },
    { with: space.did(), can: 'space/index/add' },
    { with: space.did(), can: 'upload/add' },
    { with: space.did(), can: 'upload/list' },
    { with: space.did(), can: 'filecoin/offer' },
    { with: space.did(), can: 'store/add' },
  ];
}

/**
 * @returns {Promise<{ uploadUrl: string, serviceDid: string, receiptsUrl: string, delegationHelperUrl: string }>}
 */
export async function startStorachaE2eStack() {
  const { createContext, cleanupContext } = await loadUploadApiTestContext();
  const uploadServiceContext = await createContext({
    requirePaymentPlan: false,
    http: createCorsHttp({}),
  });
  await refreshExternalServiceProofs(uploadServiceContext);

  const spaceAgent = await ed25519.generate();
  const space = await ed25519.generate();
  const spaceDid = space.did();

  const accountDid = DidMailto.fromEmail('test@example.com');
  const account = Absentee.from({ id: accountDid });
  const providerAdd = ProviderCaps.add.invoke({
    issuer: spaceAgent,
    audience: uploadServiceContext.id,
    with: account.did(),
    nb: {
      provider: uploadServiceContext.id.did(),
      consumer: space.did(),
    },
    proofs: [
      await delegate({
        issuer: account,
        audience: spaceAgent,
        capabilities: [
          {
            can: 'provider/add',
            with: account.did(),
            nb: {
              provider: uploadServiceContext.id.did(),
              consumer: space.did(),
            },
          },
        ],
      }),
    ],
  });
  await uploadServiceContext.provisionsStorage.put({
    cause: providerAdd,
    consumer: spaceDid,
    customer: account.did(),
    provider: uploadServiceContext.id.did(),
  });

  const { server: uploadApiServer, url: uploadApiUrl } = await startUploadApiServer(
    uploadServiceContext,
    {}
  );

  const helperServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/delegation') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    const audienceDid = body.audienceDid;
    if (!audienceDid || typeof audienceDid !== 'string' || !audienceDid.startsWith('did:')) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'audienceDid (did:…) required' }));
      return;
    }
    const browserPrincipal = {
      did: () => /** @type {`did:key:${string}`} */ (audienceDid),
      toArchive: () => ({ ok: new Uint8Array() }),
    };
    const delegation = await delegate({
      issuer: space,
      audience: browserPrincipal,
      capabilities: buildDelegationCapabilities(space),
      expiration: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
    });
    const delegationArchive = await delegation.archive();
    if (!delegationArchive.ok) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'delegation archive failed' }));
      return;
    }
    const delegationBase64 = 'm' + Buffer.from(delegationArchive.ok).toString('base64');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ delegation: delegationBase64 }));
  });

  await new Promise((resolve) => helperServer.listen(0, '127.0.0.1', resolve));
  const hAddr = helperServer.address();
  if (!hAddr || typeof hAddr === 'string') {
    throw new Error('delegation helper failed to bind');
  }
  const delegationHelperUrl = `http://127.0.0.1:${hAddr.port}`;

  const meta = {
    uploadUrl: uploadApiUrl,
    serviceDid: uploadServiceContext.id.did(),
    receiptsUrl: `${uploadApiUrl.replace(/\/$/, '')}/receipt/`,
    delegationHelperUrl,
  };
  writeFileSync(join(e2eDir, '.storacha-e2e.json'), JSON.stringify(meta, null, 2), 'utf8');

  state = {
    cleanupContext,
    uploadServiceContext,
    uploadApiServer,
    helperServer,
    space,
  };

  return meta;
}

export async function stopStorachaE2eStack() {
  if (!state) return;
  const { cleanupContext, uploadServiceContext, uploadApiServer, helperServer } = state;
  await new Promise((r) => helperServer.close(() => r()));
  await new Promise((r) => uploadApiServer.close(() => r()));
  await cleanupContext(uploadServiceContext);
  state = null;
}
