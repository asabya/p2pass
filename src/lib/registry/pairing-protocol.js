/**
 * libp2p Pairing Protocol for Multi-Device Linking
 *
 * Protocol: /orbitdb/link-device/1.0.0
 *
 * Message flow:
 *   Device B → Device A: { type: 'request', identity: { id, credentialId, deviceLabel } }
 *   Device A → Device B: { type: 'granted', orbitdbAddress } | { type: 'rejected', reason }
 *
 * Copied from orbitdb-identity-provider-webauthn-did/src/multi-device/pairing-protocol.js
 */

import { lpStream } from 'it-length-prefixed-stream';
import {
  getDeviceByCredentialId,
  getDeviceByDID,
  grantDeviceWriteAccess,
  registerDevice,
} from './device-registry.js';
import { peerIdFromString } from '@libp2p/peer-id';

export const LINK_DEVICE_PROTOCOL = '/orbitdb/link-device/1.0.0';

/** Relay / DCUtR paths often use a limited connection; libp2p requires this to open app streams. */
const NEW_STREAM_ON_LIMITED = { runOnLimitedConnection: true };

/**
 * Order dial candidates so cross-browser linking usually tries stable paths first:
 * public DNS + WSS, then WS/TCP via relay; webrtc-direct and LAN-only last.
 * @param {import('@multiformats/multiaddr').Multiaddr[]} parsed
 */
/**
 * Strip WebRTC-based multiaddrs from pairing. Browser WebRTC-direct dials often hit
 * "signal timed out" across NATs; relay + WSS/WS is reliable for link-device.
 * @param {import('@multiformats/multiaddr').Multiaddr[]} parsed
 */
export function filterPairingDialMultiaddrs(parsed) {
  const noWebrtc = parsed.filter((ma) => !ma.toString().toLowerCase().includes('/webrtc'));
  if (noWebrtc.length < parsed.length) {
    console.log(
      `[pairing] Omitting ${parsed.length - noWebrtc.length} WebRTC multiaddr(s); using relay/WebSocket only`
    );
  }
  return noWebrtc.length > 0 ? noWebrtc : parsed;
}

export function sortPairingMultiaddrs(parsed) {
  const score = (ma) => {
    const s = ma.toString().toLowerCase();
    let n = 0;
    if (s.includes('/webrtc')) n -= 100;
    if (s.includes('/wss/')) n += 80;
    if (s.includes('/tcp/443/')) n += 30;
    if (s.includes('/ws/') && !s.includes('wss')) n += 20;
    if (s.includes('/dns4/') || s.includes('/dns6/') || s.includes('/dnsaddr/')) n += 15;
    if (/\/ip4\/(10\.|192\.168\.|127\.)/.test(s)) n -= 50;
    if (/\/ip6\/f[cd][0-9a-f]{2}:/i.test(s)) n -= 50;
    return n;
  };
  return [...parsed].sort((a, b) => score(b) - score(a));
}

/**
 * Open the link-device stream after a relay/circuit dial.
 * Uses `libp2p.dialProtocol(peerId, …)` so the connection manager reuses the new
 * connection (same as the no-hint path). Raw `connection.newStream` right after
 * `dial(multiaddr)` often races the muxer and yields AbortError / UnexpectedEOFError.
 */
async function newLinkDeviceStreamWithRetry(libp2p, deviceAPeerId, maxAttempts = 6) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (i > 0) {
        const delay = 300 + 400 * (i - 1);
        console.log(`[pairing] Retrying dialProtocol (${i + 1}/${maxAttempts}) after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
      return await libp2p.dialProtocol(deviceAPeerId, LINK_DEVICE_PROTOCOL, NEW_STREAM_ON_LIMITED);
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? String(e);
      const name = e?.name ?? '';
      const retryable =
        name === 'AbortError' ||
        /abort|aborted|reset|closed|not readable|mux|eof|unexpected end|UnexpectedEOF/i.test(
          msg
        );
      if (!retryable || i === maxAttempts - 1) {
        throw e;
      }
      console.warn('[pairing] dialProtocol attempt failed:', name || msg);
    }
  }
  throw lastErr;
}

/**
 * Try each multiaddr in order. Avoids a single bad path (e.g. long WebRTC) stalling a batch dial.
 * @param {import('@libp2p/interface').Libp2p} libp2p
 * @param {import('@multiformats/multiaddr').Multiaddr[]} ordered
 */
async function dialPairingSequential(libp2p, ordered) {
  const PER_ATTEMPT_MS = 25_000;
  let lastErr;
  for (let i = 0; i < ordered.length; i++) {
    const ma = ordered[i];
    try {
      console.log(`[pairing] Dial ${i + 1}/${ordered.length}:`, ma.toString());
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(PER_ATTEMPT_MS)
        : undefined;
      return await libp2p.dial(ma, signal ? { signal } : {});
    } catch (e) {
      lastErr = e;
      console.warn('[pairing] Dial attempt failed:', e?.name, e?.message);
    }
  }
  throw lastErr ?? new Error('No multiaddrs to dial');
}

function decodeMessage(bytes) {
  const raw = typeof bytes.subarray === 'function' ? bytes.subarray() : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

function encodeMessage(msg) {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/**
 * Register the link-device handler on Device A (the established device).
 *
 * @param {Object} libp2p - libp2p instance
 * @param {Object} db - The device registry KV database
 * @param {Function} onRequest - async (requestMsg) => 'granted' | 'rejected'
 * @param {Function} [onDeviceLinked] - (deviceEntry) => void
 */
export async function registerLinkDeviceHandler(libp2p, db, onRequest, onDeviceLinked) {
  console.log('[pairing] Registering handler for protocol:', LINK_DEVICE_PROTOCOL, 'on peer:', libp2p.peerId.toString());
  await libp2p.handle(LINK_DEVICE_PROTOCOL, async ({ stream, connection }) => {
    console.log('[pairing] Received incoming connection from:', connection?.remotePeer?.toString());
    const lp = lpStream(stream);
    let result;

    try {
      console.log('[pairing] Waiting for request message...');
      const request = decodeMessage(await lp.read());
      console.log('[pairing] Received request:', request.type);

      if (request.type !== 'request') {
        await stream.close();
        return;
      }

      const { identity } = request;
      console.log('[pairing] Request identity DID:', identity.id);
      const isKnown =
        (await getDeviceByCredentialId(db, identity.credentialId)) ||
        (await getDeviceByDID(db, identity.id));

      console.log('[pairing] Is known device:', !!isKnown);
      if (isKnown) {
        console.log('[pairing] Device is known, granting access and triggering callback');
        result = { type: 'granted', orbitdbAddress: db.address };
        if (isKnown && onDeviceLinked) {
          onDeviceLinked({
            credential_id: identity.credentialId,
            public_key: identity.publicKey || null,
            device_label: identity.deviceLabel || 'Linked Device',
            created_at: isKnown.created_at || Date.now(),
            status: 'active',
            ed25519_did: identity.id,
          });
        }
      } else {
        const decision = await onRequest(request);
        console.log('[pairing] Pairing request decision:', decision);
        if (decision === 'granted') {
          console.log('[pairing] Granting write access for DID:', identity.id);
          await grantDeviceWriteAccess(db, identity.id);
          // Also grant write access for Device B's OrbitDB identity (may differ from DID)
          if (identity.orbitdbIdentityId && identity.orbitdbIdentityId !== identity.id) {
            console.log('[pairing] Granting write access for OrbitDB identity:', identity.orbitdbIdentityId);
            await grantDeviceWriteAccess(db, identity.orbitdbIdentityId);
          }
          console.log('[pairing] Write access granted, registering device...');
          const deviceEntry = {
            credential_id: identity.credentialId,
            public_key: identity.publicKey || null,
            device_label: identity.deviceLabel || 'Unknown Device',
            created_at: Date.now(),
            status: 'active',
            ed25519_did: identity.id,
          };
          try {
            await registerDevice(db, deviceEntry);
            console.log('[pairing] Device registered successfully');
            result = { type: 'granted', orbitdbAddress: db.address };
            onDeviceLinked?.(deviceEntry);
          } catch (registerErr) {
            console.error('[pairing] Failed to register device:', registerErr.message);
            console.log('[pairing] Retrying device registration...');
            await new Promise(resolve => setTimeout(resolve, 500));
            await registerDevice(db, deviceEntry);
            console.log('[pairing] Device registered successfully on retry');
            result = { type: 'granted', orbitdbAddress: db.address };
            onDeviceLinked?.(deviceEntry);
          }
        } else {
          result = { type: 'rejected', reason: 'User cancelled' };
        }
      }
    } catch (err) {
      console.error('[pairing-protocol] handler error:', err);
      result = { type: 'rejected', reason: err.message };
    }

    try {
      await lp.write(encodeMessage(result));
      await stream.close();
    } catch (writeErr) {
      console.warn('[pairing-protocol] error writing response:', writeErr);
    }
  });
}

/**
 * Unregister the link-device handler from libp2p.
 * @param {Object} libp2p - libp2p instance
 */
export async function unregisterLinkDeviceHandler(libp2p) {
  await libp2p.unhandle(LINK_DEVICE_PROTOCOL);
}

/**
 * Detect a human-readable device label from the browser user-agent.
 * @returns {string}
 */
export function detectDeviceLabel() {
  if (typeof navigator === 'undefined') return 'Unknown Device';
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown Device';
}

/**
 * Device B side: dial Device A and send a pairing request.
 *
 * @param {Object} libp2p - libp2p instance (Device B)
 * @param {string|Object} deviceAPeerId - peerId string or PeerId object of Device A
 * @param {Object} identity - { id, credentialId, publicKey?, deviceLabel? }
 * @param {string[]} [hintMultiaddrs] - Known multiaddrs for Device A (from QR payload)
 * @returns {Promise<{type: 'granted', orbitdbAddress: string}|{type: 'rejected', reason: string}>}
 */
export async function sendPairingRequest(libp2p, deviceAPeerId, identity, hintMultiaddrs = []) {
  let stream;

  let peerId;
  if (typeof deviceAPeerId === 'string') {
    peerId = peerIdFromString(deviceAPeerId);
  } else if (deviceAPeerId?.toMultihash) {
    peerId = deviceAPeerId;
  } else if (deviceAPeerId?.id) {
    peerId = peerIdFromString(deviceAPeerId.id);
  } else {
    throw new Error(`Invalid deviceAPeerId: ${JSON.stringify(deviceAPeerId)}`);
  }

  if (hintMultiaddrs.length > 0) {
    try {
      console.log('[pairing] Attempting to dial with hint multiaddrs:', hintMultiaddrs);
      const { multiaddr } = await import('@multiformats/multiaddr');
      const parsedMultiaddrs = hintMultiaddrs
        .map((a) => {
          try {
            return multiaddr(a);
          } catch (e) {
            console.warn('[pairing] failed to parse multiaddr:', a, e.message);
            return null;
          }
        })
        .filter(Boolean);

      if (parsedMultiaddrs.length === 0) {
        throw new Error(`No valid multiaddrs for deviceAPeerId: ${deviceAPeerId}`);
      }

      const forDial = sortPairingMultiaddrs(filterPairingDialMultiaddrs(parsedMultiaddrs));
      console.log('[pairing] Dial order (best first):', forDial.map((m) => m.toString()));

      let connection;
      try {
        connection = await dialPairingSequential(libp2p, forDial);
      } catch (e) {
        console.error('[pairing] All dial attempts failed. Last error:', e?.name, e?.message);
        throw new Error(`Failed to dial Device A: ${e.message}`);
      }

      const remoteStr = connection.remotePeer.toString();
      console.log('[pairing] Dial successful, remote:', remoteStr);
      if (remoteStr !== peerId.toString()) {
        console.warn(
          '[pairing] Connection remote peer does not match pasted Device A peerId — check peer info JSON.',
          { expected: peerId.toString(), actual: remoteStr }
        );
      }

      try {
        stream = await newLinkDeviceStreamWithRetry(libp2p, peerId);
        console.log('[pairing] Link-device stream ready');
      } catch (e) {
        console.error('[pairing] dialProtocol failed (dial OK):', e?.name, e?.message);
        throw new Error(`Failed to open link-device stream: ${e.message}`);
      }
    } catch (e) {
      if (e.message?.startsWith('Failed to dial') || e.message?.startsWith('Failed to open link-device')) {
        throw e;
      }
      console.error('[pairing] Pairing transport error:', e?.message);
      throw new Error(`Failed to connect to Device A: ${e.message}`);
    }
  } else {
    stream = await libp2p.dialProtocol(peerId, LINK_DEVICE_PROTOCOL, NEW_STREAM_ON_LIMITED);
  }

  const lp = lpStream(stream);
  await lp.write(encodeMessage({
    type: 'request',
    identity: {
      id: identity.id,
      orbitdbIdentityId: identity.orbitdbIdentityId || null,
      credentialId: identity.credentialId,
      publicKey: identity.publicKey || null,
      deviceLabel: identity.deviceLabel || detectDeviceLabel(),
    },
  }));

  const result = decodeMessage(await lp.read());
  await stream.close();
  return result;
}
