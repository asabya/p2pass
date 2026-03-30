/**
 * libp2p pairing for multi-device linking over `/orbitdb/link-device/1.0.0`.
 *
 * **Message flow**
 * - Device B → A: `{ type: 'request', identity: { … } }`
 * - Device A → B: `{ type: 'granted', orbitdbAddress }` or `{ type: 'rejected', reason }`
 *
 * @module registry/pairing-protocol
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

/**
 * Max multiaddrs to advertise and to try per pairing (sorted best-first). Avoids huge paste blobs,
 * redundant dials, and tripping libp2p {@link https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md connectionManager.maxPeerAddrsToDial}.
 */
export const PAIRING_HINT_ADDR_CAP = 8;

function takeTopPairingMultiaddrs(parsed) {
  const sorted = sortPairingMultiaddrs(filterPairingDialMultiaddrs(parsed));
  if (sorted.length <= PAIRING_HINT_ADDR_CAP) return sorted;
  console.log(
    `[pairing] Using top ${PAIRING_HINT_ADDR_CAP} of ${sorted.length} multiaddrs (rest omitted)`
  );
  return sorted.slice(0, PAIRING_HINT_ADDR_CAP);
}

/**
 * Structured pairing debug — filter the browser console by `[pairing-flow]`.
 * @param {'ALICE'|'BOB'} role
 * @param {string} phase
 * @param {Record<string, unknown>|string} [detail]
 */
export function pairingFlow(role, phase, detail) {
  if (detail === undefined) {
    console.log(`[pairing-flow] ${role} — ${phase}`);
  } else if (typeof detail === 'string') {
    console.log(`[pairing-flow] ${role} — ${phase}: ${detail}`);
  } else {
    console.log(`[pairing-flow] ${role} — ${phase}`, detail);
  }
}

/**
 * Relay / DCUtR paths often use a limited connection; libp2p requires this to open app streams.
 * Use default negotiateFully (true): half-open negotiation (`negotiateFully: false`) can leave the
 * remote without a registered protocol handler until first I/O — on circuit relays that often
 * ends in stream reset before Alice’s `handle()` runs.
 */
const LINK_DEVICE_STREAM_OPTS = {
  runOnLimitedConnection: true,
};

/**
 * Must align with {@link LINK_DEVICE_STREAM_OPTS}. Circuit paths are "limited" connections; libp2p’s
 * inbound path rejects the app handler unless `runOnLimitedConnection` is set on the registered
 * protocol — otherwise Bob gets an immediate stream reset with no Alice logs.
 */
const LINK_DEVICE_HANDLER_OPTS = {
  runOnLimitedConnection: true,
};

/**
 * Strip WebRTC-based multiaddrs from pairing. Browser WebRTC-direct dials often hit
 * "signal timed out" across NATs; relay + WSS/WS is more reliable for link-device.
 *
 * @param {import('@multiformats/multiaddr').Multiaddr[]} parsed
 * @returns {import('@multiformats/multiaddr').Multiaddr[]}
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

/**
 * Order dial candidates so cross-browser linking usually tries stable paths first
 * (public DNS + WSS, then WS/TCP via relay; WebRTC-direct and LAN-only last).
 *
 * @param {import('@multiformats/multiaddr').Multiaddr[]} parsed
 * @returns {import('@multiformats/multiaddr').Multiaddr[]}
 */
export function sortPairingMultiaddrs(parsed) {
  const score = (ma) => {
    const s = ma.toString().toLowerCase();
    let n = 0;
    if (s.includes('/webrtc')) n -= 100;
    /** Browser↔browser linking is usually relay/circuit; prefer over raw LAN IPs in the path. */
    if (s.includes('/p2p-circuit')) n += 60;
    /** Same-host relay: IPv4 loopback often more reliable than ::1 for WS/circuit in browsers. */
    if (s.includes('/p2p-circuit') && s.includes('/ip4/127.0.0.1/')) n += 35;
    if (s.includes('/p2p-circuit') && s.includes('/ip6/::1/')) n += 12;
    if (s.includes('/wss/')) n += 80;
    if (s.includes('/tcp/443/')) n += 30;
    if (s.includes('/ws/') && !s.includes('wss')) n += 20;
    if (s.includes('/dns4/') || s.includes('/dns6/') || s.includes('/dnsaddr/')) n += 15;
    if (/\/ip4\/(10\.|192\.168\.)/.test(s)) n -= 50;
    if (/\/ip4\/127\./.test(s) && !s.includes('/p2p-circuit')) n -= 50;
    if (/\/ip6\/f[cd][0-9a-f]{2}:/i.test(s)) n -= 50;
    return n;
  };
  return [...parsed].sort((a, b) => score(b) - score(a));
}

/**
 * Open the link-device stream on the connection we just dialed, or dial(peerId) then newStream.
 *
 * After `dial(multiaddr)` succeeds on relay/WS, `dialProtocol(peerId)` calls `dial(peerId)` again
 * and may open a different path (e.g. WebRTC). Prefer `connection.newStream` on the established
 * connection. With peer-id only, `dial(peerId)` + `newStream` matches connection-manager routing
 * but keeps stream options (negotiateFully, runOnLimitedConnection) explicit.
 */
async function newLinkDeviceStreamWithRetry(
  libp2p,
  deviceAPeerId,
  existingConnection = null,
  maxAttempts = 6
) {
  const OPEN_CONN_MS = 20_000;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (i > 0) {
        const delay = 300 + 400 * (i - 1);
        console.log(
          `[pairing] Retrying link-device stream (${i + 1}/${maxAttempts}) after ${delay}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        await new Promise((r) => setTimeout(r, existingConnection ? 120 : 200));
      }
      if (existingConnection) {
        return await existingConnection.newStream(LINK_DEVICE_PROTOCOL, LINK_DEVICE_STREAM_OPTS);
      }
      const openSignal =
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(OPEN_CONN_MS)
          : undefined;
      const conn = await libp2p.dial(deviceAPeerId, openSignal ? { signal: openSignal } : {});
      return await conn.newStream(LINK_DEVICE_PROTOCOL, LINK_DEVICE_STREAM_OPTS);
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? String(e);
      const name = e?.name ?? '';
      const retryable =
        name === 'AbortError' ||
        /abort|aborted|reset|closed|not readable|mux|eof|unexpected end|UnexpectedEOF/i.test(msg);
      if (!retryable || i === maxAttempts - 1) {
        throw e;
      }
      console.warn('[pairing] link-device stream attempt failed:', name || msg);
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
      const signal =
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
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

/**
 * Prefer circuit path when multiple connections exist (browser relay case).
 * @param {import('@libp2p/interface').Libp2p} libp2p
 * @param {import('@libp2p/interface').PeerId} peerId
 */
function pickExistingConnection(libp2p, peerId) {
  const list = libp2p.getConnections(peerId);
  if (!list?.length) return null;
  const circuit = list.find((c) => (c.remoteAddr?.toString() || '').includes('/p2p-circuit'));
  return circuit ?? list[0];
}

/**
 * Peer-id-only linking: reuse live connection, or dial addresses from peer store (pubsub/identify),
 * then open link-device on that connection. Avoids fragile `dial(peerId)` when discovery failed but
 * addrs are known, or when a connection already exists.
 * @param {import('@libp2p/interface').Libp2p} libp2p
 * @param {import('@libp2p/interface').PeerId} peerId
 */
async function openLinkDeviceStreamPeerIdOnly(libp2p, peerId) {
  const existing = pickExistingConnection(libp2p, peerId);
  if (existing) {
    pairingFlow('BOB', 'peer-id mode: reusing existing libp2p connection', {
      remoteAddr: existing.remoteAddr?.toString?.(),
    });
    console.log('[pairing] peer-id mode: reusing existing connection to', peerId.toString());
    return await newLinkDeviceStreamWithRetry(libp2p, peerId, existing);
  }

  let storeMultiaddrs = [];
  try {
    const peerData = await libp2p.peerStore.get(peerId);
    storeMultiaddrs = peerData.addresses.map((a) => a.multiaddr);
  } catch (e) {
    if (e?.name !== 'NotFoundError') {
      console.warn('[pairing] peerStore.get:', e?.message);
    }
  }

  const forDial = takeTopPairingMultiaddrs(storeMultiaddrs);
  if (forDial.length > 0) {
    pairingFlow('BOB', 'peer-id mode: dialing peer store address(es)', { count: forDial.length });
    console.log('[pairing] peer-id mode: dialing', forDial.length, 'address(es) from peer store');
    let connection;
    try {
      connection = await dialPairingSequential(libp2p, forDial);
    } catch (e) {
      throw new Error(
        `Could not dial Device A from peer store: ${e.message}. ` +
          'Wait until both sides show a P2P connection, or paste peer info including multiaddrs.',
        { cause: e }
      );
    }
    return await newLinkDeviceStreamWithRetry(libp2p, peerId, connection);
  }

  pairingFlow(
    'BOB',
    'peer-id mode: no connection and no dialable addrs in peer store — trying dial(peerId)'
  );
  console.warn(
    '[pairing] peer-id mode: no existing connection and no dialable addresses in peer store'
  );
  return await newLinkDeviceStreamWithRetry(libp2p, peerId, null);
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
  console.log(
    '[pairing] Registering handler for protocol:',
    LINK_DEVICE_PROTOCOL,
    'on peer:',
    libp2p.peerId.toString()
  );
  await libp2p.handle(
    LINK_DEVICE_PROTOCOL,
    async ({ stream, connection }) => {
      const remotePeer = connection?.remotePeer?.toString?.() ?? '?';
      const remoteAddr = connection?.remoteAddr?.toString?.() ?? '?';
      pairingFlow('ALICE', 'libp2p: inbound stream on link-device protocol', {
        ourPeerId: libp2p.peerId.toString(),
        remotePeer,
        remoteAddr,
        direction: connection?.direction,
      });
      console.log('[pairing] Received incoming connection from:', remotePeer);
      const lp = lpStream(stream);
      let result;

      try {
        console.log('[pairing] Waiting for request message...');
        const request = decodeMessage(await lp.read());
        console.log('[pairing] Received request:', request.type);

        if (request.type !== 'request') {
          pairingFlow('ALICE', 'ignored: first message was not type=request', {
            type: request.type,
          });
          await stream.close();
          return;
        }

        const { identity } = request;
        pairingFlow('ALICE', 'decoded request from Bob (length-prefixed JSON)', {
          did: identity?.id,
          deviceLabel: identity?.deviceLabel,
          credentialId: identity?.credentialId
            ? `${String(identity.credentialId).slice(0, 12)}…`
            : null,
          orbitdbIdentityId: identity?.orbitdbIdentityId || null,
        });
        console.log('[pairing] Request identity DID:', identity.id);
        const isKnown =
          (await getDeviceByCredentialId(db, identity.credentialId)) ||
          (await getDeviceByDID(db, identity.id));

        console.log('[pairing] Is known device:', !!isKnown);
        if (isKnown) {
          pairingFlow('ALICE', 'device already in registry — auto-grant (no approval UI)', {
            did: identity.id,
          });
          console.log('[pairing] Device is known, granting access and triggering callback');
          result = { type: 'granted', orbitdbAddress: db.address };
          if (isKnown && onDeviceLinked) {
            onDeviceLinked({
              ...isKnown,
              credential_id: identity.credentialId,
              public_key: identity.publicKey ?? isKnown.public_key ?? null,
              device_label: identity.deviceLabel || isKnown.device_label || 'Linked Device',
              created_at: isKnown.created_at || Date.now(),
              status: 'active',
              ed25519_did: identity.id,
              passkey_kind: identity.passkeyKind || isKnown.passkey_kind || null,
            });
          }
        } else {
          pairingFlow(
            'ALICE',
            'unknown device — waiting for onPairingRequest (UI must resolve granted/rejected)'
          );
          const decision = await onRequest(request);
          pairingFlow('ALICE', 'onPairingRequest resolved', { decision });
          console.log('[pairing] Pairing request decision:', decision);
          if (decision === 'granted') {
            console.log('[pairing] Granting write access for DID:', identity.id);
            await grantDeviceWriteAccess(db, identity.id);
            // Also grant write access for Device B's OrbitDB identity (may differ from DID)
            if (identity.orbitdbIdentityId && identity.orbitdbIdentityId !== identity.id) {
              console.log(
                '[pairing] Granting write access for OrbitDB identity:',
                identity.orbitdbIdentityId
              );
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
              passkey_kind: identity.passkeyKind || null,
            };
            try {
              await registerDevice(db, deviceEntry);
              console.log('[pairing] Device registered successfully');
              result = { type: 'granted', orbitdbAddress: db.address };
              onDeviceLinked?.(deviceEntry);
            } catch (registerErr) {
              console.error('[pairing] Failed to register device:', registerErr.message);
              console.log('[pairing] Retrying device registration...');
              await new Promise((resolve) => setTimeout(resolve, 500));
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
        pairingFlow('ALICE', 'handler exception — sending rejected to Bob', {
          error: err?.message,
        });
        result = { type: 'rejected', reason: err.message };
      }

      try {
        pairingFlow('ALICE', 'writing response on same stream (length-prefixed) → Bob', {
          type: result?.type,
          orbitdbAddress:
            result?.type === 'granted'
              ? String(result.orbitdbAddress || '').slice(0, 48) + '…'
              : undefined,
          reason: result?.reason,
        });
        await lp.write(encodeMessage(result));
        pairingFlow('ALICE', 'response sent; closing stream');
        await stream.close();
      } catch (writeErr) {
        console.warn('[pairing-protocol] error writing response:', writeErr);
        pairingFlow('ALICE', 'failed to write response or close stream', {
          error: writeErr?.message,
        });
      }
    },
    LINK_DEVICE_HANDLER_OPTS
  );
}

/**
 * Unregister the link-device handler from libp2p.
 * @param {Object} libp2p - libp2p instance
 */
export async function unregisterLinkDeviceHandler(libp2p) {
  await libp2p.unhandle(LINK_DEVICE_PROTOCOL);
}

/**
 * Best-effort OS name when Client Hints are missing (uses UA + navigator.platform).
 * @param {string} ua
 * @param {string} navPlatform
 * @returns {string}
 */
function guessOsName(ua, navPlatform) {
  if (/iPhone/.test(ua)) return 'iOS';
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua) || /^Mac/i.test(navPlatform)) return 'macOS';
  if (/Windows/.test(ua) || /^Win/i.test(navPlatform)) return 'Windows';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux/.test(ua) || /Linux/i.test(navPlatform)) return 'Linux';
  return '';
}

/**
 * Browser name + major (or Safari minor) version from the User-Agent string.
 * Order matters (e.g. Edge and Opera both contain "Chrome").
 * @param {string} ua
 * @returns {string}
 */
function parseBrowserLabelFromUserAgent(ua) {
  if (!ua) return '';
  let m = ua.match(/\sEdgiOS\/(\d+)/i);
  if (m) return `Edge ${m[1]}`;
  m = ua.match(/\sEdgA\/(\d+)/i);
  if (m) return `Edge ${m[1]}`;
  m = ua.match(/\sEdg\/(\d+)/);
  if (m) return `Edge ${m[1]}`;
  m = ua.match(/\sEdge\/(\d+)/);
  if (m) return `Edge ${m[1]}`;
  m = ua.match(/\sOPR\/(\d+)/);
  if (m) return `Opera ${m[1]}`;
  m = ua.match(/\sSamsungBrowser\/(\d+)/);
  if (m) return `Samsung Internet ${m[1]}`;
  m = ua.match(/\sCriOS\/(\d+)/);
  if (m) return `Chrome ${m[1]}`;
  m = ua.match(/\sFxiOS\/(\d+)/);
  if (m) return `Firefox ${m[1]}`;
  m = ua.match(/\sBrave\/(\d+)/i);
  if (m) return `Brave ${m[1]}`;
  m = ua.match(/\sChrome\/(\d+)/);
  if (m) return `Chrome ${m[1]}`;
  m = ua.match(/\sFirefox\/(\d+)/);
  if (m) return `Firefox ${m[1]}`;
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Brave/i.test(ua)) {
    m = ua.match(/Version\/(\d+(?:\.\d+)?)/);
    if (m) return `Safari ${m[1]}`;
    return 'Safari';
  }
  return '';
}

/**
 * Human-readable device label from navigator (Client Hints OS + legacy platform), UA OS fallback,
 * and browser name/version from {@link navigator.userAgent}.
 * @returns {string}
 */
export function detectDeviceLabel() {
  if (typeof navigator === 'undefined') return 'Unknown Device';

  const osFromHints =
    typeof navigator.userAgentData?.platform === 'string'
      ? navigator.userAgentData.platform.trim()
      : '';
  const platRaw = typeof navigator.platform === 'string' ? navigator.platform.trim() : '';
  const navPlatform = platRaw && platRaw !== 'Unknown' ? platRaw : '';
  const ua = navigator.userAgent || '';

  /** @type {string} */
  let base;
  if (osFromHints && navPlatform) {
    const ol = osFromHints.toLowerCase();
    const pl = navPlatform.toLowerCase();
    if (pl.includes(ol) || ol.includes(pl)) base = osFromHints;
    else base = `${osFromHints} · ${navPlatform}`;
  } else if (osFromHints) {
    base = osFromHints;
  } else if (navPlatform) {
    const osGuess = guessOsName(ua, navPlatform);
    if (osGuess && osGuess.toLowerCase() !== navPlatform.toLowerCase()) {
      base = `${osGuess} · ${navPlatform}`;
    } else {
      base = navPlatform;
    }
  } else if (/iPhone/.test(ua)) base = 'iPhone';
  else if (/iPad/.test(ua)) base = 'iPad';
  else if (/Android/.test(ua)) base = 'Android';
  else if (/Mac/.test(ua)) base = 'Mac';
  else if (/Windows/.test(ua)) base = 'Windows';
  else if (/Linux/.test(ua)) base = 'Linux';
  else base = 'Unknown Device';

  const browser = parseBrowserLabelFromUserAgent(ua);
  if (browser) return `${base} · ${browser}`;
  return base;
}

/**
 * Device B side: dial Device A and send a pairing request.
 *
 * @param {Object} libp2p - libp2p instance (Device B)
 * @param {string|Object} deviceAPeerId - peerId string or PeerId object of Device A
 * @param {Object} identity - { id, credentialId, publicKey?, deviceLabel?, passkeyKind? }
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

      const forDial = takeTopPairingMultiaddrs(parsedMultiaddrs);
      console.log(
        '[pairing] Dial order (best first):',
        forDial.map((m) => m.toString())
      );

      let connection;
      try {
        connection = await dialPairingSequential(libp2p, forDial);
      } catch (e) {
        console.error('[pairing] All dial attempts failed. Last error:', e?.name, e?.message);
        throw new Error(`Failed to dial Device A: ${e.message}`, { cause: e });
      }

      const remoteStr = connection.remotePeer.toString();
      console.log('[pairing] Dial successful, remote:', remoteStr);
      if (remoteStr !== peerId.toString()) {
        console.warn(
          '[pairing] Connection remote peer does not match pasted Device A peerId — check the peer id.',
          { expected: peerId.toString(), actual: remoteStr }
        );
      }

      try {
        stream = await newLinkDeviceStreamWithRetry(libp2p, peerId, connection);
        console.log('[pairing] Link-device stream ready');
      } catch (e) {
        console.error('[pairing] link-device stream failed (dial OK):', e?.name, e?.message);
        throw new Error(`Failed to open link-device stream: ${e.message}`, { cause: e });
      }
    } catch (e) {
      if (
        e.message?.startsWith('Failed to dial') ||
        e.message?.startsWith('Failed to open link-device')
      ) {
        throw e;
      }
      console.error('[pairing] Pairing transport error:', e?.message);
      throw new Error(`Failed to connect to Device A: ${e.message}`, { cause: e });
    }
  } else {
    try {
      stream = await openLinkDeviceStreamPeerIdOnly(libp2p, peerId);
      console.log('[pairing] Link-device stream ready (peer-id mode)');
    } catch (e) {
      console.error('[pairing] peer-id mode failed:', e?.name, e?.message);
      throw new Error(
        e.message?.startsWith('Could not dial Device A')
          ? e.message
          : `Failed to open link-device stream: ${e.message}`,
        { cause: e }
      );
    }
  }

  const lp = lpStream(stream);
  const outbound = {
    type: 'request',
    identity: {
      id: identity.id,
      orbitdbIdentityId: identity.orbitdbIdentityId || null,
      credentialId: identity.credentialId,
      publicKey: identity.publicKey || null,
      deviceLabel: identity.deviceLabel || detectDeviceLabel(),
      passkeyKind: identity.passkeyKind || null,
    },
  };
  pairingFlow('BOB', 'sending link-device REQUEST (length-prefixed JSON) to Alice', {
    alicePeerId: peerId.toString(),
    myDid: identity.id,
    deviceLabel: outbound.identity.deviceLabel,
  });
  await lp.write(encodeMessage(outbound));

  pairingFlow('BOB', 'waiting for RESPONSE from Alice on same stream…');
  const result = decodeMessage(await lp.read());
  pairingFlow('BOB', 'received RESPONSE from Alice', {
    type: result?.type,
    orbitdbAddress:
      result?.type === 'granted'
        ? String(result.orbitdbAddress || '').slice(0, 48) + '…'
        : undefined,
    reason: result?.reason,
  });
  await stream.close();
  pairingFlow('BOB', 'stream closed after pairing RPC complete');
  return result;
}
