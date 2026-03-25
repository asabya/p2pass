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
import { webRTC } from '@libp2p/webrtc';
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
import {
  OrbitDBWebAuthnIdentityProviderFunction,
} from '@le-space/orbitdb-identity-provider-webauthn-did';

const parseAddrList = (value) =>
  (value || '').split(',').map((s) => s.trim()).filter(Boolean);

function getEnv(key) {
  try { return import.meta.env?.[key] || ''; } catch { return ''; }
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
  { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
];

/**
 * Create a browser-compatible libp2p instance.
 *
 * @param {Object} [options]
 * @param {string[]} [options.bootstrapList] - Bootstrap peer multiaddrs (defaults to relay from env)
 * @returns {Promise<Object>} libp2p instance
 */
export async function createLibp2pInstance(options = {}) {
  const { bootstrapList } = options;
  const peers = bootstrapList && bootstrapList.length > 0
    ? bootstrapList
    : getDefaultBootstrapList();

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
      webRTC({ rtcConfiguration: { iceServers: STUN_SERVERS } }),
      circuitRelayTransport({ reservationCompletionTimeout: 20_000 }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    connectionManager: {
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

  // Debug: log connection events and relay reservations
  libp2p.addEventListener('peer:connect', (evt) => {
    console.log('[p2p] Peer connected:', evt.detail.toString());
  });
  libp2p.addEventListener('peer:disconnect', (evt) => {
    console.log('[p2p] Peer disconnected:', evt.detail.toString());
  });
  libp2p.addEventListener('self:peer:update', () => {
    const addrs = libp2p.getMultiaddrs().map((ma) => ma.toString());
    console.log('[p2p] Self peer update — multiaddrs:', addrs);
  });

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
  const libp2pNode = options.libp2p || await createLibp2pInstance(options);
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
