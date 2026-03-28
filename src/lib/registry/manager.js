/**
 * MultiDeviceManager - Unified class for multi-device OrbitDB with WebAuthn
 *
 * Copied from orbitdb-identity-provider-webauthn-did/src/multi-device/manager.js
 * with imports adapted for the p2p-passkeys package.
 */

import {
  openDeviceRegistry,
  registerDevice,
  listDevices,
  getDeviceByCredentialId,
  getDeviceByDID,
  grantDeviceWriteAccess,
  revokeDeviceAccess,
  coseToJwk,
} from './device-registry.js';

import {
  detectDeviceLabel,
  sendPairingRequest,
  registerLinkDeviceHandler,
  LINK_DEVICE_PROTOCOL,
  sortPairingMultiaddrs,
  pairingFlow,
  PAIRING_HINT_ADDR_CAP,
} from './pairing-protocol.js';

export class MultiDeviceManager {
  /**
   * @param {string|{ peerId: string, multiaddrs?: string[] }} payload
   * @returns {{ peerId: string, multiaddrs: string[] }}
   */
  static _normalizeLinkPayload(payload) {
    if (typeof payload === 'string') {
      const peerId = payload.trim();
      if (!peerId) throw new Error('peerId is empty');
      return { peerId, multiaddrs: [] };
    }
    if (payload && typeof payload === 'object' && typeof payload.peerId === 'string') {
      return {
        peerId: payload.peerId.trim(),
        multiaddrs: Array.isArray(payload.multiaddrs) ? payload.multiaddrs : [],
      };
    }
    throw new Error('linkToDevice: expected a peer id string or { peerId, multiaddrs? }');
  }

  constructor() {
    this._credential = null;
    this._orbitdb = null;
    this._ipfs = null;
    this._libp2p = null;
    this._identity = null;
    this._devicesDb = null;
    this._dbAddress = null;
    this._onPairingRequest = null;
    this._onDeviceLinked = null;
    this._onDeviceJoined = null;
    this._listenersSetup = false;
  }

  static async create(config) {
    const manager = new MultiDeviceManager();
    await manager._init(config);
    return manager;
  }

  static async createFromExisting(config) {
    const manager = new MultiDeviceManager();
    manager._credential = config.credential;
    manager._orbitdb = config.orbitdb;
    manager._ipfs = config.ipfs;
    manager._libp2p = config.libp2p;
    manager._identity = config.identity;
    manager._onPairingRequest = config.onPairingRequest || null;
    manager._onDeviceLinked = config.onDeviceLinked || null;
    manager._onDeviceJoined = config.onDeviceJoined || null;
    return manager;
  }

  async _init(config) {
    if (!config.credential) throw new Error('credential is required');
    this._credential = config.credential;
    this._onPairingRequest = config.onPairingRequest || null;
    this._onDeviceLinked = config.onDeviceLinked || null;
    this._onDeviceJoined = config.onDeviceJoined || null;
    if (config.orbitdb) this._orbitdb = config.orbitdb;
    if (config.ipfs) this._ipfs = config.ipfs;
    if (config.libp2p) this._libp2p = config.libp2p;
    if (config.identity) this._identity = config.identity;
  }

  _getPublicKey() {
    const { x, y } = this._credential.publicKey || {};
    return x && y ? coseToJwk(x, y) : null;
  }

  async _finalizeDb() {
    await this._setupSyncListeners();
    if (this._onPairingRequest) {
      // Unregister existing handler before re-registering (e.g. after DB reopen)
      try {
        await this._libp2p.unhandle(LINK_DEVICE_PROTOCOL);
      } catch {
        /* not registered */
      }
      console.log(
        '[manager] Registering link device handler for peer:',
        this._libp2p?.peerId?.toString()
      );
      await registerLinkDeviceHandler(
        this._libp2p,
        this._devicesDb,
        this._onPairingRequest,
        this._onDeviceLinked
      );
      console.log('[manager] Link device handler registered');
    }
  }

  async createNew() {
    if (!this._orbitdb) {
      throw new Error(
        'orbitdb not provided. Pass orbitdb, ipfs, libp2p, identity in config, or use createFromExisting().'
      );
    }

    this._devicesDb = await openDeviceRegistry(this._orbitdb, this._identity.id);
    this._dbAddress = this._devicesDb.address;

    await registerDevice(this._devicesDb, {
      credential_id:
        this._credential?.credentialId ||
        this._credential?.id ||
        this._libp2p?.peerId?.toString() ||
        'unknown',
      public_key: this._getPublicKey(),
      device_label: detectDeviceLabel(),
      created_at: Date.now(),
      status: 'active',
      ed25519_did: this._identity.id,
    });

    await this.syncDevices();
    await this._finalizeDb();

    return { dbAddress: this._dbAddress, identity: this._identity };
  }

  async _setupSyncListeners() {
    if (this._listenersSetup || !this._devicesDb) {
      console.log('[manager] _setupSyncListeners: skipping (already set up or no db)');
      return;
    }
    this._listenersSetup = true;

    console.log('[manager] Setting up sync listeners for DB:', this._devicesDb.address?.toString());

    if (this._onDeviceJoined) {
      console.log('[manager] Subscribing to join events');
      this._devicesDb.events.on('join', async (peerId, details) => {
        console.log('[manager] JOIN event fired:', peerId.toString(), details);
        if (this._onDeviceJoined) {
          this._onDeviceJoined(peerId.toString(), details);
        }
        if (this._onDeviceLinked) {
          const devices = await listDevices(this._devicesDb);
          console.log('[manager] JOIN: Refreshing device list, found:', devices.length);
          for (const device of devices) {
            this._onDeviceLinked(device);
          }
        }
      });
    }

    this._devicesDb.events.on('update', async (_entry) => {
      console.log('[manager] UPDATE event fired, _onDeviceLinked:', !!this._onDeviceLinked);
      if (this._onDeviceLinked) {
        const devices = await listDevices(this._devicesDb);
        console.log('[manager] UPDATE: Devices found:', devices.length);
        for (const device of devices) {
          console.log(
            '[manager] UPDATE: Triggering callback for device:',
            device.device_label,
            device.ed25519_did,
            'status:',
            device.status
          );
          this._onDeviceLinked(device);
        }
      }
    });
    console.log('[manager] Sync listeners setup complete');
  }

  async _waitForEntries(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const entries = await listDevices(this._devicesDb);
      if (entries.length > 0) {
        console.log(
          '[manager] _waitForEntries: found',
          entries.length,
          'entries after',
          Date.now() - start,
          'ms'
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.warn('[manager] _waitForEntries: timed out after', timeoutMs, 'ms with 0 entries');
  }

  async openExistingDb(dbAddress) {
    if (!this._orbitdb) {
      throw new Error('orbitdb not provided. Pass orbitdb, ipfs, libp2p, identity in config.');
    }
    this._devicesDb = await openDeviceRegistry(this._orbitdb, this._identity.id, dbAddress);
    this._dbAddress = this._devicesDb.address;
    await this._finalizeDb();
    return { dbAddress: this._dbAddress, identity: this._identity };
  }

  /**
   * Link to Device A by peer id. Uses addresses already in libp2p’s peer store (e.g. from pubsub
   * discovery + autodial). Optional legacy shape: `{ peerId, multiaddrs }` for explicit dials.
   * @param {string|{ peerId: string, multiaddrs?: string[] }} qrPayload
   */
  async linkToDevice(qrPayload) {
    if (!this._orbitdb) {
      throw new Error('orbitdb not provided. Pass orbitdb, ipfs, libp2p, identity in config.');
    }

    const { peerId, multiaddrs } = MultiDeviceManager._normalizeLinkPayload(qrPayload);
    console.log('[linkToDevice] Target peerId:', peerId, 'hint addrs:', multiaddrs.length);
    console.log('[linkToDevice] My peerId:', this._libp2p?.peerId?.toString());

    const result = await sendPairingRequest(
      this._libp2p,
      peerId,
      {
        id: this._identity.id,
        orbitdbIdentityId: this._orbitdb?.identity?.id || null,
        credentialId:
          this._credential?.credentialId || this._credential?.id || this._libp2p.peerId.toString(),
        publicKey: null,
        deviceLabel: detectDeviceLabel(),
      },
      multiaddrs
    );

    pairingFlow('BOB', 'linkToDevice: sendPairingRequest finished', {
      type: result?.type,
      hasOrbitdbAddress: result?.type === 'granted' && !!result.orbitdbAddress,
      reason: result?.reason,
    });

    if (result.type === 'rejected') return result;

    console.log('[linkToDevice] Got granted, opening database...');
    pairingFlow('BOB', 'opening shared OrbitDB registry at address from Alice…');
    this._devicesDb = await openDeviceRegistry(
      this._orbitdb,
      this._identity.id,
      result.orbitdbAddress
    );
    this._dbAddress = this._devicesDb.address;
    console.log('[linkToDevice] Database opened, waiting for Device A entries to sync...');

    this._listenersSetup = false;
    await this._setupSyncListeners();
    await this._waitForEntries(15000);
    await this._finalizeDb();

    pairingFlow(
      'BOB',
      'linkToDevice complete: registry open + sync listeners + handler re-registered',
      {
        dbAddress: String(this._dbAddress || '').slice(0, 56) + '…',
      }
    );
    return { type: 'granted', dbAddress: this._dbAddress };
  }

  getDevicesDb() {
    return this._devicesDb;
  }

  getPeerInfo() {
    if (!this._libp2p) throw new Error('Libp2p not initialized');
    const peerId = this._libp2p.peerId.toString();
    const filtered = this._libp2p.getMultiaddrs().filter((ma) => {
      const lower = ma.toString().toLowerCase();
      return (
        (lower.includes('/ws/') ||
          lower.includes('/wss/') ||
          lower.includes('/webtransport') ||
          lower.includes('/p2p-circuit')) &&
        !lower.includes('/webrtc') &&
        !lower.includes('/ip4/127.') &&
        !lower.includes('/ip4/localhost') &&
        !lower.includes('/ip6/::1')
      );
    });
    const sorted = sortPairingMultiaddrs(filtered);
    const capped = sorted.slice(0, PAIRING_HINT_ADDR_CAP);
    const multiaddrs = capped.map((ma) => ma.toString());
    return { peerId, multiaddrs };
  }

  async listDevices() {
    if (!this._devicesDb) return [];
    await this.syncDevices();
    return listDevices(this._devicesDb);
  }

  async syncDevices() {
    // OrbitDB syncs automatically with connected peers (sync: true in openDeviceRegistry).
  }

  async revokeDevice(did) {
    if (!this._devicesDb) throw new Error('Device registry not initialized');
    await revokeDeviceAccess(this._devicesDb, did);
  }

  async processIncomingPairingRequest(requestMsg) {
    if (!this._devicesDb) throw new Error('Device registry not initialized');
    const { identity } = requestMsg;

    const isKnown =
      (await getDeviceByCredentialId(this._devicesDb, identity.credentialId)) ||
      (await getDeviceByDID(this._devicesDb, identity.id));

    if (isKnown) {
      return { type: 'granted', orbitdbAddress: this._dbAddress };
    }

    const decision = this._onPairingRequest ? await this._onPairingRequest(requestMsg) : 'granted';

    if (decision === 'granted') {
      await grantDeviceWriteAccess(this._devicesDb, identity.id);
      await registerDevice(this._devicesDb, {
        credential_id: identity.credentialId,
        public_key: identity.publicKey || null,
        device_label: identity.deviceLabel || 'Unknown Device',
        created_at: Date.now(),
        status: 'active',
        ed25519_did: identity.id,
      });
      return { type: 'granted', orbitdbAddress: this._dbAddress };
    }
    return { type: 'rejected', reason: 'User cancelled' };
  }

  /** Get the underlying registry DB (for extended operations like delegation storage). */
  getRegistryDb() {
    return this._devicesDb;
  }

  /** Get the registry DB address. */
  getDbAddress() {
    return this._dbAddress;
  }

  async close() {
    try {
      if (this._devicesDb) await this._devicesDb.close();
      if (this._orbitdb) await this._orbitdb.stop();
      if (this._ipfs) await this._ipfs.stop();
    } catch (error) {
      console.warn('Error during cleanup:', error);
    }
  }
}
