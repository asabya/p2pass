/**
 * P2P stack setup — libp2p + Helia + OrbitDB for browser environments.
 *
 * Relay/bootstrap config ported from NiKrause/simple-todo/src/lib/libp2p-config.js
 */

import { createOrbitDB, Identities, useIdentityProvider } from '@orbitdb/core';
import { createLibp2p } from 'libp2p';
import { createHelia } from 'helia';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify, identifyPush } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { bootstrap } from '@libp2p/bootstrap';
import { autoNAT } from '@libp2p/autonat';
import { dcutr } from '@libp2p/dcutr';
import { ping } from '@libp2p/ping';
import { LevelBlockstore } from 'blockstore-level';
import { LevelDatastore } from 'datastore-level';
import { OrbitDBWebAuthnIdentityProviderFunction } from '@le-space/orbitdb-identity-provider-webauthn-did';

const parseAddrList = (value) =>
  (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function getEnv(key) {
  try {
    return import.meta.env?.[key] || '';
  } catch {
    return '';
  }
}

function getDefaultBootstrapList() {
  const seeds = getEnv('VITE_BOOTSTRAP_PEERS');
  if (seeds) return parseAddrList(seeds);
  console.warn('[p2p] No VITE_BOOTSTRAP_PEERS set — node will have no relay/bootstrap peers');
  return [];
}

const PUBSUB_PEER_DISCOVERY_TOPIC =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PUBSUB_TOPICS) ||
  'p2p-passkeys._peer-discovery._p2p._pubsub';

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
];

/** Last `/p2p/<peerId>` segment from each multiaddr — bootstrap list is usually the relay. */
function peerIdsFromBootstrapMultiaddrs(multiaddrs) {
  const ids = new Set();
  for (const ma of multiaddrs) {
    const parts = String(ma).split('/p2p/');
    if (parts.length > 1) {
      const id = parts[parts.length - 1].split('/')[0];
      if (id) ids.add(id);
    }
  }
  return ids;
}

function attachRelayConnectionLogging(libp2p, bootstrapMultiaddrs) {
  const relayPeerIds = peerIdsFromBootstrapMultiaddrs(bootstrapMultiaddrs);
  if (relayPeerIds.size === 0) return;

  const peerStr = (evt) => evt.detail?.toString?.() ?? String(evt.detail);

  libp2p.addEventListener('peer:connect', (evt) => {
    const id = peerStr(evt);
    if (relayPeerIds.has(id)) {
      console.log('[p2p] Relay (bootstrap) peer connected:', id);
    }
  });
  libp2p.addEventListener('peer:disconnect', (evt) => {
    const id = peerStr(evt);
    if (relayPeerIds.has(id)) {
      console.log('[p2p] Relay (bootstrap) peer disconnected:', id);
    }
  });
}

const rtcConfig = { iceServers: STUN_SERVERS };

/**
 * Dial peers discovered via pubsub (and other discovery). One `dial(peerId)` per event — libp2p’s
 * connection manager + peer store pick addresses; looping every multiaddr is redundant and can
 * amplify failures (e.g. repeated protocol negotiation on bad paths).
 */
function attachPeerDiscoveryAutoDial(libp2p, { enablePeerConnections = true } = {}) {
  if (!enablePeerConnections) return;

  const DIAL_MS = 30_000;

  libp2p.addEventListener('peer:discovery', (event) => {
    const { id: remotePeerId, multiaddrs } = event.detail || {};
    if (!remotePeerId) return;

    const self = libp2p.peerId;
    if (remotePeerId.equals?.(self) || remotePeerId.toString() === self.toString()) return;

    const n = Array.isArray(multiaddrs) ? multiaddrs.length : 0;
    if (n > 0) {
      console.log('[p2p] peer:discovery:', remotePeerId.toString(), `(event addrs: ${n})`);
    }

    const existing = libp2p.getConnections(remotePeerId);
    const hasDirect = existing?.some((conn) => {
      const a = conn.remoteAddr?.toString() || '';
      return !a.includes('/p2p-circuit');
    });
    if (hasDirect) return;

    (async () => {
      try {
        const signal =
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(DIAL_MS)
            : undefined;
        await libp2p.dial(remotePeerId, signal ? { signal } : {});
      } catch (err) {
        console.warn('[p2p] peer:discovery dial failed:', remotePeerId.toString(), err?.message || err);
      }
    })();
  });
}

/**
 * Create a browser-compatible libp2p instance.
 *
 * @param {Object} [options]
 * @param {string[]} [options.bootstrapList] - Bootstrap peer multiaddrs (defaults to relay from env)
 * @param {boolean} [options.enablePeerConnections=true] - Auto-dial peers from `peer:discovery`
 * @returns {Promise<Object>} libp2p instance
 */
export async function createLibp2pInstance(options = {}) {
  const { bootstrapList, enablePeerConnections = true } = options;
  const peers =
    bootstrapList && bootstrapList.length > 0 ? bootstrapList : getDefaultBootstrapList();

  const peerDiscovery = [
    pubsubPeerDiscovery({
      interval: 3_000,
      topics: [PUBSUB_PEER_DISCOVERY_TOPIC],
      listenOnly: false,
    }),
  ];

  if (peers.length > 0) {
    peerDiscovery.push(bootstrap({ list: peers }));
    console.log('[p2p] Bootstrap peers:', peers);
  }

  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/p2p-circuit', '/webrtc'],
    },
    transports: [
      webSockets(),
      webRTCDirect({ rtcConfiguration: rtcConfig }),
      webRTC({ rtcConfiguration: rtcConfig }),
      circuitRelayTransport({ reservationCompletionTimeout: 20_000 }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    connectionManager: {
      /** Default 25 can throw `Peer had more than maxPeerAddrsToDial` when the peer store lists many paths (relay + LAN + IPv6). */
      maxPeerAddrsToDial: 128,
      inboundStreamProtocolNegotiationTimeout: 10_000,
      inboundUpgradeTimeout: 10_000,
      outboundStreamProtocolNegotiationTimeout: 10_000,
      outboundUpgradeTimeout: 10_000,
    },
    peerDiscovery,
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      pubsub: gossipsub({
        emitSelf: true,
        allowPublishToZeroTopicPeers: true,
      }),
      autonat: autoNAT(),
      dcutr: dcutr(),
      ping: ping(),
    },
  });

  console.log('[p2p] libp2p started, peerId:', libp2p.peerId.toString());
  attachRelayConnectionLogging(libp2p, peers);
  attachPeerDiscoveryAutoDial(libp2p, { enablePeerConnections });

  return libp2p;
}

/**
 * Create a Helia IPFS instance with persistent Level storage.
 *
 * @param {Object} libp2p - libp2p instance
 * @param {string} [dbPath] - path prefix for Level storage
 * @returns {Promise<Object>} Helia instance
 */
export async function createHeliaInstance(libp2p, dbPath = './p2p-passkeys') {
  const ipfs = await createHelia({
    libp2p,
    blockstore: new LevelBlockstore(`${dbPath}/blocks`),
    datastore: new LevelDatastore(`${dbPath}/data`),
  });

  console.log('[p2p] Helia IPFS started');
  return ipfs;
}

/**
 * Complete OrbitDB setup with WebAuthn identity.
 *
 * @param {Object} credential - WebAuthn credential object
 * @param {Object} [options]
 * @param {string[]} [options.bootstrapList] - Bootstrap peers
 * @param {boolean} [options.encryptKeystore] - Enable PRF encryption (default: true)
 * @param {string} [options.keystoreEncryptionMethod] - 'prf' (default)
 * @param {string} [options.dbPath] - Level storage path
 * @returns {Promise<{ orbitdb: Object, ipfs: Object, libp2p: Object, identity: Object }>}
 */
export async function setupP2PStack(credential, options = {}) {
  const libp2pNode = options.libp2p || (await createLibp2pInstance(options));
  const ipfs = await createHeliaInstance(libp2pNode, options.dbPath);

  let identity;

  // Only use WebAuthn identity provider if credential has full properties
  // (i.e., a live credential from navigator.credentials, not a localStorage restoration)
  if (credential?.response || credential?.getClientExtensionResults) {
    useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);
    const identities = await Identities({ ipfs });
    identity = await identities.createIdentity({
      provider: OrbitDBWebAuthnIdentityProviderFunction({
        webauthnCredential: credential,
        useKeystoreDID: true,
        keystore: identities.keystore,
        keystoreKeyType: 'Ed25519',
        encryptKeystore: options.encryptKeystore !== false,
        keystoreEncryptionMethod: options.keystoreEncryptionMethod || 'prf',
      }),
    });
    console.log('[p2p] OrbitDB identity created (WebAuthn):', identity.id);
  } else {
    console.log('[p2p] Using default OrbitDB identity');
  }

  const orbitdbOpts = { ipfs };
  if (identity) {
    const identities = await Identities({ ipfs });
    orbitdbOpts.identities = identities;
    orbitdbOpts.identity = identity;
  }
  const orbitdb = await createOrbitDB(orbitdbOpts);
  console.log('[p2p] OrbitDB started');

  return { orbitdb, ipfs, libp2p: libp2pNode, identity };
}

/**
 * Cleanup all P2P resources.
 *
 * @param {Object} stack - { orbitdb, ipfs, libp2p }
 */
export async function cleanupP2PStack(stack) {
  try {
    if (stack.orbitdb) await stack.orbitdb.stop();
    if (stack.ipfs) await stack.ipfs.stop();
    console.log('[p2p] Cleanup complete');
  } catch (err) {
    console.warn('[p2p] Cleanup error:', err.message);
  }
}
