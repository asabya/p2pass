<script>
  import { onMount } from 'svelte';
  import {
    readSigningPreferenceFromStorage,
    writeSigningPreferenceToStorage,
  } from '../identity/signing-preference.js';
  // Per-icon entrypoints avoid the root `lucide-svelte` barrel (`export *`), which can trigger
  // "Importing binding name 'default' cannot be resolved by star export entries" in strict ESM.
  import Upload from 'lucide-svelte/icons/upload';
  import LogOut from 'lucide-svelte/icons/log-out';
  import Loader2 from 'lucide-svelte/icons/loader-2';
  import AlertCircle from 'lucide-svelte/icons/alert-circle';
  import CheckCircle from 'lucide-svelte/icons/check-circle';
  import Download from 'lucide-svelte/icons/download';
  import { getSpaceUsage } from './storacha-backup.js';
  import { OrbitDBStorachaBridge } from 'orbitdb-storacha-bridge';
  import { IdentityService, hasLocalPasskeyHint } from '../identity/identity-service.js';
  import { getStoredSigningMode } from '../identity/mode-detector.js';
  import {
    createStorachaClient,
    parseDelegation,
    storeDelegation,
    loadStoredDelegation,
    clearStoredDelegation,
    formatDelegationsTooltipSummary,
  } from '../ucan/storacha-auth.js';
  import {
    openDeviceRegistry,
    registerDevice,
    getDeviceByDID,
    listDevices as listRegistryDevices,
    getArchiveEntry,
    listKeypairs,
    storeKeypairEntry,
    storeArchiveEntry,
    listDelegations,
    storeDelegationEntry,
    removeDeviceEntry,
    delegationsEntriesForDevice,
    hashCredentialId,
  } from '../registry/device-registry.js';
  import {
    createManifest,
    publishManifest,
    resolveManifest,
    uploadArchiveToIPFS,
    fetchArchiveFromIPFS,
  } from '../recovery/manifest.js';
  import { backupRegistryDb } from '../backup/registry-backup.js';
  import { MultiDeviceManager } from '../registry/manager.js';
  import { detectDeviceLabel, pairingFlow } from '../registry/pairing-protocol.js';
  import { loadWebAuthnCredentialSafe } from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';
  import './fonts/storacha-fonts.css';

  let {
    orbitdb = null,
    database = null,
    isInitialized = false,
    entryCount = 0,
    databaseName = 'restored-db',
    onRestore = () => {},
    onBackup = () => {},
    onAuthenticate = () => {},
    /** Parent (e.g. StorachaFab) must show the floating panel — otherwise pairing UI is `display:none`. */
    onPairingPromptOpen = () => {},
    libp2p = null,
    /** @deprecated Use {@link signingPreference} `'worker'` instead */
    preferWorkerMode = false,
    /** When set, overrides the in-panel signing mode selector (e.g. programmatic / tests). */
    signingPreference: signingPreferenceOverride = null,
  } = $props();

  /** User-chosen strategy before passkey create/auth; persisted in localStorage. */
  let selectedSigningPreference = $state(
    /** @type {'hardware-ed25519' | 'hardware-p256' | 'worker'} */ ('hardware-ed25519')
  );

  onMount(() => {
    const stored = readSigningPreferenceFromStorage();
    if (stored) selectedSigningPreference = stored;
  });

  function setSigningPreference(/** @type {'hardware-ed25519' | 'hardware-p256' | 'worker'} */ p) {
    selectedSigningPreference = p;
    writeSigningPreferenceToStorage(p);
  }

  /** Emoji for linked-device row; works with {@link detectDeviceLabel} strings (OS · platform, etc.). */
  function linkedDeviceIcon(/** @type {string | undefined} */ label) {
    const s = (label || '').toLowerCase();
    if (s.includes('iphone')) return '\uD83D\uDCF1';
    if (s.includes('ipados') || s.includes('ipad')) return '\uD83D\uDCF1';
    if (s.includes('android')) return '\uD83D\uDCF1';
    if (s.includes('mac') || s.includes('ios')) return '\uD83D\uDCBB';
    if (s.includes('win')) return '\uD83D\uDDA5\uFE0F';
    if (s.includes('linux')) return '\uD83D\uDC27';
    return '\uD83D\uDCF1';
  }

  /** @param {{ mode?: string, algorithm?: string } | null} sm */
  function passkeyKindFromSigningMode(sm) {
    if (!sm) return null;
    if (sm.mode === 'worker') return 'worker-ed25519';
    if (sm.algorithm === 'P-256') return 'hardware-p256';
    return 'hardware-ed25519';
  }

  /** Passkey kind label for a registry device row (stored passkey_kind, else local session). */
  function linkedDevicePasskeyLabel(/** @type {Record<string, unknown>} */ device) {
    const k = device.passkey_kind;
    if (typeof k === 'string' && k) return k;
    if (signingMode?.did && device.ed25519_did === signingMode.did) {
      return passkeyKindFromSigningMode(signingMode);
    }
    return null;
  }

  /** UCAN delegation counts keyed by device DID (see {@link delegationsEntriesForDevice}). */
  let ucanCountsByDid = $state(/** @type {Record<string, number>} */ ({}));
  /** Parsed UCAN summary for each device row’s badge `title`. */
  let ucanTooltipByDid = $state(/** @type {Record<string, string>} */ ({}));

  async function refreshLinkedDeviceDelegationCounts() {
    if (!registryDb) {
      ucanCountsByDid = {};
      ucanTooltipByDid = {};
      return;
    }
    try {
      const delegations = await listDelegations(registryDb);
      const ownerDid = localStorage.getItem(OWNER_DID_KEY) || signingMode?.did || '';
      /** @type {Record<string, number>} */
      const next = {};
      /** @type {Record<string, string>} */
      const tips = {};
      for (const dev of devices) {
        const did = dev.ed25519_did;
        if (typeof did !== 'string' || !did) continue;
        const entries = delegationsEntriesForDevice(delegations, did, ownerDid);
        next[did] = entries.length;
        if (entries.length > 0) {
          tips[did] = await formatDelegationsTooltipSummary(
            /** @type {Array<{ delegation?: string, space_did?: string, label?: string }>} */ (
              entries
            )
          );
        }
      }
      ucanCountsByDid = next;
      ucanTooltipByDid = tips;
    } catch {
      ucanCountsByDid = {};
      ucanTooltipByDid = {};
    }
  }

  async function confirmRemoveLinkedDevice(/** @type {Record<string, unknown>} */ device) {
    const label = String(device.device_label || device.ed25519_did || 'this device');
    const credId = device.credential_id;
    if (typeof credId !== 'string' || !credId) {
      showMessage('Cannot remove device: missing credential id.', 'error');
      return;
    }
    if (
      !confirm(
        `Remove linked device "${label}" from the registry? Its OrbitDB write access will be revoked.`
      )
    ) {
      return;
    }
    const db = deviceManager?.getRegistryDb?.() ?? registryDb;
    if (!db) {
      showMessage('Cannot remove device: registry not ready.', 'error');
      return;
    }
    try {
      await removeDeviceEntry(db, credId);
      devices = devices.filter((d) => d.ed25519_did !== device.ed25519_did);
      await refreshLinkedDeviceDelegationCounts();
      showMessage('Device removed from linked devices.');
    } catch (err) {
      showMessage(`Failed to remove device: ${err?.message || err}`, 'error');
    }
  }

  // Component state
  let showStoracha = $state(true);
  let isLoading = $state(false);
  let error = $state(null);
  let success = $state(null);

  // Auth state
  let isLoggedIn = $state(false);
  let client = $state(null);
  let currentSpace = $state(null);

  // Progress tracking state
  let showProgress = $state(false);
  let progressType = $state('');
  let progressCurrent = $state(0);
  let progressTotal = $state(0);
  let progressPercentage = $state(0);
  let progressCurrentBlock = $state(null);
  let progressError = $state(null);

  // Bridge instance
  let bridge = null;

  // Passkey + UCAN state
  let identityService = new IdentityService();
  let signingMode = $state(null); // { mode, did, algorithm, secure }
  let delegationText = $state(''); // textarea for pasting delegation
  let isAuthenticating = $state(false);
  /** Shown when creating a new passkey; sent as WebAuthn user.id / name / displayName (worker path). */
  let passkeyUserLabel = $state('');
  let spaceUsage = $state(null);

  // Registry DB state
  let registryDb = $state(null);
  const REGISTRY_ADDRESS_KEY = 'p2p_passkeys_registry_address';
  const OWNER_DID_KEY = 'p2p_passkeys_owner_did';

  // Tab state
  let activeTab = $state('passkeys'); // 'storacha' | 'passkeys' — P2P Passkeys first (primary)

  // P2P Passkeys state
  let devices = $state([]);
  let peerInfo = $state(null);
  let linkInput = $state('');
  let isLinking = $state(false);
  let linkError = $state('');
  let deviceManager = $state(null);
  /** Prevents duplicate concurrent init from initRegistryDb + $effect. */
  let deviceManagerInitInProgress = false;
  let pendingPairRequest = $state(null);
  let pendingPairResolve = $state(null);

  // Recovery state
  let isRecovering = $state(false);
  let recoveryStatus = $state('');
  let ipnsKeyPair = $state(null);
  let ipnsNameString = $state('');
  /** UI hint: local passkey / archive / registry keypair present — primary button shows "existing" copy. */
  let localPasskeyDetected = $state(false);

  const primaryPasskeyLabel = $derived(
    localPasskeyDetected ? 'Authenticate with existing Passkey' : 'Create new Passkey'
  );
  const primaryPasskeyLoadingLabel = $derived(
    localPasskeyDetected ? 'Authenticating...' : 'Creating...'
  );
  const passkeyStepHint = $derived(
    localPasskeyDetected
      ? 'Step 1: Sign in with your saved passkey, or recover from backup'
      : 'Step 1: Create a new passkey, or recover an existing one from backup'
  );

  /** At least one remote peer (e.g. via bootstrap relay / circuit — not necessarily direct). */
  let p2pHasRemotePeers = $state(false);
  /** At least one open connection whose multiaddr uses WebRTC (browser direct path). */
  let p2pHasDirectWebRtc = $state(false);
  /** Count of connected remote peers (`libp2p.getPeers().length`). */
  let p2pRemotePeerCount = $state(0);

  function addrLooksLikeDirectWebRtc(maStr) {
    const s = (maStr || '').toLowerCase();
    return s.includes('/webrtc') || s.includes('webrtc-direct');
  }

  function syncP2pConnectionFlags(node) {
    if (!node || typeof node.getPeers !== 'function') {
      p2pHasRemotePeers = false;
      p2pHasDirectWebRtc = false;
      p2pRemotePeerCount = 0;
      return;
    }
    try {
      const peers = node.getPeers();
      p2pRemotePeerCount = peers.length;
      p2pHasRemotePeers = peers.length > 0;
      const conns = typeof node.getConnections === 'function' ? node.getConnections() : [];
      p2pHasDirectWebRtc = conns.some((c) => addrLooksLikeDirectWebRtc(c.remoteAddr?.toString?.()));
    } catch {
      p2pHasRemotePeers = false;
      p2pHasDirectWebRtc = false;
      p2pRemotePeerCount = 0;
    }
  }

  $effect(() => {
    const db = registryDb;
    if (!db) return;
    void (async () => {
      try {
        const sm = await getStoredSigningMode(db);
        if (sm.mode) localPasskeyDetected = true;
      } catch {
        /* ignore */
      }
    })();
  });

  $effect(() => {
    const node = libp2p;
    if (!node) {
      p2pHasRemotePeers = false;
      p2pHasDirectWebRtc = false;
      p2pRemotePeerCount = 0;
      return;
    }
    syncP2pConnectionFlags(node);
    const onChange = () => syncP2pConnectionFlags(node);
    node.addEventListener('peer:connect', onChange);
    node.addEventListener('peer:disconnect', onChange);
    node.addEventListener('connection:open', onChange);
    node.addEventListener('connection:close', onChange);
    return () => {
      node.removeEventListener('peer:connect', onChange);
      node.removeEventListener('peer:disconnect', onChange);
      node.removeEventListener('connection:open', onChange);
      node.removeEventListener('connection:close', onChange);
    };
  });

  /** Per-device UCAN delegation counts for linked-device badges. */
  $effect(() => {
    registryDb;
    devices;
    signingMode?.did;
    isLoggedIn;
    void refreshLinkedDeviceDelegationCounts();
  });

  /** Start MultiDeviceManager once libp2p + registry exist (handles restored signingMode / late orbitdb). */
  $effect(() => {
    if (!signingMode?.did || !orbitdb || !libp2p || !registryDb || deviceManager) return;
    void initDeviceManager();
  });

  /** Gray = no stack; red = no peers; orange = relay / non-WebRTC only; green = ≥1 WebRTC direct transport. */
  const p2pLedDotBg = $derived(
    !libp2p
      ? '#9ca3af'
      : !p2pHasRemotePeers
        ? '#ef4444'
        : p2pHasDirectWebRtc
          ? '#10b981'
          : '#f97316'
  );
  const p2pLedShadow = $derived(
    !libp2p
      ? 'none'
      : !p2pHasRemotePeers
        ? '0 0 0 3px rgba(239, 68, 68, 0.25)'
        : p2pHasDirectWebRtc
          ? '0 0 0 3px rgba(16, 185, 129, 0.2)'
          : '0 0 0 3px rgba(249, 115, 22, 0.22)'
  );
  const p2pLedPulse = $derived(!!libp2p && p2pHasRemotePeers);
  const p2pLedTextColor = $derived(
    !libp2p
      ? '#6B7280'
      : !p2pHasRemotePeers
        ? '#991b1b'
        : p2pHasDirectWebRtc
          ? '#064e3b'
          : '#9a3412'
  );
  const p2pConnectionLabel = $derived(
    !libp2p
      ? 'P2P Offline'
      : !p2pHasRemotePeers
        ? 'No remote peers'
        : p2pHasDirectWebRtc
          ? 'P2P Direct (WebRTC)'
          : 'P2P Relay'
  );

  /** Link Device needs MultiDeviceManager (registry DB + libp2p). */
  const linkDeviceReady = $derived(!!deviceManager);
  const linkDeviceDisabled = $derived(isLinking || !linkInput.trim() || !linkDeviceReady);

  function resetProgress() {
    showProgress = false;
    progressType = '';
    progressCurrent = 0;
    progressTotal = 0;
    progressPercentage = 0;
    progressCurrentBlock = null;
    progressError = null;
  }

  function showMessage(message, type = 'info') {
    if (type === 'error') {
      error = message;
      success = null;
    } else {
      success = message;
      error = null;
    }
    setTimeout(() => {
      error = null;
      success = null;
    }, 5000);
  }

  async function handleAuthenticate() {
    isAuthenticating = true;
    try {
      signingMode = await identityService.initialize(undefined, {
        preferWorkerMode,
        signingPreference: signingPreferenceOverride ?? selectedSigningPreference,
        ...(localPasskeyDetected ? {} : { webauthnUserLabel: passkeyUserLabel }),
      });
      showMessage(`Authenticated! Mode: ${signingMode.algorithm} (${signingMode.mode})`);

      // Notify parent that authentication succeeded — await so P2P stack can init
      await onAuthenticate(signingMode);

      // Derive IPNS keypair for manifest operations
      const kp = identityService.getIPNSKeyPair();
      if (kp) ipnsKeyPair = kp;

      // Open/create registry DB if OrbitDB is available
      await initRegistryDb();

      // Try auto-connect if delegation is stored (ignore whitespace-only junk)
      const stored = await loadStoredDelegation(registryDb);
      if (stored?.trim()) await handleConnectWithDelegation(stored.trim());
    } catch (err) {
      showMessage(`Authentication failed: ${err.message}`, 'error');
    } finally {
      isAuthenticating = false;
    }
  }

  /**
   * Connect Storacha using a delegation string: parse, create client, set up bridge.
   * Optionally stores the delegation to registry or localStorage.
   */
  async function connectStoracha(
    delegationStr,
    { store = false, storeRegistryDb = null, storeSpaceDid = '' } = {}
  ) {
    const [delegation, principal] = await Promise.all([
      parseDelegation(delegationStr),
      identityService.getPrincipal(),
    ]);
    client = await createStorachaClient(principal, delegation);

    if (store) {
      const spaceDid = storeSpaceDid || client.currentSpace()?.did?.() || '';
      await storeDelegation(
        delegationStr,
        storeRegistryDb,
        spaceDid,
        signingMode?.did || ''
      );
    }

    currentSpace = client.currentSpace();
    isLoggedIn = true;

    bridge = new OrbitDBStorachaBridge({ ucanClient: client });
    if (currentSpace) bridge.spaceDID = currentSpace.did();
    setupBridgeListeners();
    await loadSpaceUsage();
  }

  async function handleRecover() {
    isRecovering = true;
    recoveryStatus = 'Authenticating with passkey...';
    try {
      const recovery = await identityService.initializeFromRecovery();
      ipnsKeyPair = recovery.ipnsKeyPair;

      const storedDid = localStorage.getItem(OWNER_DID_KEY);
      const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
      let recoveredLocally = false;

      if (storedDid && storedAddr) {
        console.log('[recovery] Attempting local OrbitDB path — DID:', storedDid);
        recoveredLocally = await recoverFromLocalOrbitDB(storedDid, storedAddr);
      } else {
        console.log('[recovery] No local DID/registry cached, using IPNS');
      }

      if (!recoveredLocally) {
        console.log('[recovery] Using IPNS/IPFS remote path');
        await recoverFromIPNS(recovery.ipnsKeyPair);
      }

      recoveryStatus = '';
      showMessage('Identity recovered successfully!');
    } catch (err) {
      showMessage(`Recovery failed: ${err.message}`, 'error');
      recoveryStatus = '';
      signingMode = null;
    } finally {
      isRecovering = false;
    }
  }

  /**
   * Local-first recovery: start P2P with default identity, open the local
   * OrbitDB registry, and restore the archive without hitting the network.
   */
  async function recoverFromLocalOrbitDB(storedDid, storedAddr) {
    try {
      recoveryStatus = 'Starting P2P stack...';
      await onAuthenticate(null);

      // Wait for Svelte prop propagation with retry
      let waited = 0;
      while (!orbitdb && waited < 2000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      if (!orbitdb) {
        console.log('[recovery:local] orbitdb not available after wait');
        return false;
      }

      recoveryStatus = 'Opening local registry...';
      const db = await openDeviceRegistry(orbitdb, storedDid, storedAddr);

      const archiveEntry = await getArchiveEntry(db, storedDid);
      if (!archiveEntry) {
        console.log('[recovery:local] No archive in local OrbitDB for DID:', storedDid);
        return false;
      }

      recoveryStatus = 'Restoring identity from local registry...';
      await identityService.restoreFromManifest(archiveEntry, storedDid);
      signingMode = identityService.getSigningMode();
      console.log('[recovery:local] DID restored:', signingMode?.did);

      registryDb = db;
      await identityService.setRegistry(db);
      await selfRegisterDevice();
      // Local recovery bypasses initRegistryDb(), so MultiDeviceManager was never started — same as normal auth.
      recoveryStatus = 'Initializing device linking...';
      await initDeviceManager();

      const stored = await loadStoredDelegation(db);
      if (stored) {
        recoveryStatus = 'Connecting to Storacha...';
        await connectStoracha(stored);
      }

      console.log('[recovery:local] Succeeded — no network needed');
      return true;
    } catch (err) {
      console.warn('[recovery:local] Failed:', err.message);
      return false;
    }
  }

  /**
   * IPNS/IPFS fallback recovery: resolve the manifest from w3name,
   * fetch the encrypted archive from the gateway, and restore.
   * Stores the DID in localStorage for future local recoveries.
   */
  async function recoverFromIPNS(ipnsKP) {
    recoveryStatus = 'Resolving IPNS manifest...';
    const manifest = await resolveManifest(ipnsKP.privateKey);
    if (!manifest) {
      throw new Error('No recovery manifest found. This identity may not have been backed up yet.');
    }
    console.log('[recovery:ipns] Manifest resolved — ownerDid:', manifest.ownerDid);

    if (!manifest.archiveCID) {
      throw new Error('Manifest has no archiveCID. Cannot restore identity without it.');
    }
    recoveryStatus = 'Fetching encrypted archive...';
    const archiveEntry = await fetchArchiveFromIPFS(manifest.archiveCID);
    if (!archiveEntry) {
      throw new Error('Failed to fetch encrypted archive from IPFS.');
    }

    recoveryStatus = 'Restoring identity...';
    await identityService.restoreFromManifest(archiveEntry, manifest.ownerDid);
    signingMode = identityService.getSigningMode();
    console.log('[recovery:ipns] DID restored:', signingMode?.did);

    // Only persist DID — registry address is stored when OrbitDB is actually opened
    localStorage.setItem(OWNER_DID_KEY, manifest.ownerDid);

    recoveryStatus = 'Starting P2P stack...';
    await onAuthenticate(signingMode);

    // Wait for orbitdb prop to propagate from parent
    let waited = 0;
    while (!orbitdb && waited < 2000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }

    // Open registry DB so address gets persisted for future local recovery
    await initRegistryDb();

    if (manifest.delegation) {
      recoveryStatus = 'Connecting to Storacha...';
      await connectStoracha(manifest.delegation, { store: true, storeRegistryDb: registryDb });
    }

    console.log(
      '[recovery:ipns] Succeeded — DID + registry address cached for future local recovery'
    );
  }

  async function handlePublishManifest() {
    if (!client || !registryDb || !signingMode?.did) return;

    // Derive IPNS keypair if not already available
    if (!ipnsKeyPair) {
      const kp = identityService.getIPNSKeyPair();
      if (!kp) {
        console.warn('[ui] No IPNS keypair available, cannot publish manifest');
        return;
      }
      ipnsKeyPair = kp;
    }

    try {
      const addr = registryDb.address?.toString?.() || registryDb.address;

      // Get the current delegation string
      const delegationStr = await loadStoredDelegation(registryDb);

      // Upload encrypted archive to IPFS for auth-free recovery
      let archiveCID = null;
      const archiveData = await identityService.getEncryptedArchiveData();
      if (archiveData) {
        try {
          archiveCID = await uploadArchiveToIPFS(client, archiveData);
          console.log('[ui] Archive uploaded to IPFS:', archiveCID);
        } catch (err) {
          console.warn('[ui] Failed to upload archive to IPFS:', err.message);
        }
      }

      const manifest = createManifest({
        registryAddress: addr,
        delegation: delegationStr || '',
        ownerDid: signingMode.did,
        archiveCID,
      });

      const result = await publishManifest(client, ipnsKeyPair.privateKey, manifest);
      ipnsNameString = result.nameString;

      // Persist DID for future local-first recovery
      localStorage.setItem(OWNER_DID_KEY, signingMode.did);

      console.log('[ui] Manifest published:', result.nameString);
    } catch (err) {
      console.warn('[ui] Failed to publish manifest:', err.message);
    }
  }

  async function selfRegisterDevice() {
    if (!registryDb || !signingMode?.did) return;
    try {
      const existing = await getDeviceByDID(registryDb, signingMode.did);
      const kind = passkeyKindFromSigningMode(signingMode);
      if (existing) {
        if (kind && !existing.passkey_kind) {
          const k = await hashCredentialId(existing.credential_id);
          await registryDb.put(k, { ...existing, passkey_kind: kind });
        }
        return;
      }
      const credential = loadWebAuthnCredentialSafe();
      await registerDevice(registryDb, {
        credential_id:
          credential?.credentialId ||
          credential?.id ||
          libp2p?.peerId?.toString() ||
          signingMode.did,
        public_key:
          credential?.publicKey?.x && credential?.publicKey?.y
            ? { kty: 'EC', crv: 'P-256', x: credential.publicKey.x, y: credential.publicKey.y }
            : null,
        device_label: detectDeviceLabel(),
        created_at: Date.now(),
        status: 'active',
        ed25519_did: signingMode.did,
        passkey_kind: kind,
      });
      console.log('[ui] Self-registered device in registry');
    } catch (err) {
      console.warn('[ui] Failed to self-register device:', err.message);
    }
  }

  async function initRegistryDb() {
    if (!orbitdb || !signingMode?.did) return;
    try {
      const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
      registryDb = await openDeviceRegistry(orbitdb, signingMode.did, storedAddr);

      const addr = registryDb.address?.toString?.() || registryDb.address;
      if (addr) localStorage.setItem(REGISTRY_ADDRESS_KEY, addr);
      localStorage.setItem(OWNER_DID_KEY, signingMode.did);

      await identityService.setRegistry(registryDb);
      await selfRegisterDevice();
      console.log('[ui] Registry DB initialized:', addr, '— DID persisted:', signingMode.did);
      await initDeviceManager();
    } catch (err) {
      // If a stored address exists but we can't write, it's from a different identity.
      // Clear it and create a fresh registry for this identity.
      const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
      if (storedAddr) {
        console.warn('[ui] Stale registry address, creating new registry:', err.message);
        localStorage.removeItem(REGISTRY_ADDRESS_KEY);
        try {
          registryDb = await openDeviceRegistry(orbitdb, signingMode.did, null);
          const addr = registryDb.address?.toString?.() || registryDb.address;
          if (addr) localStorage.setItem(REGISTRY_ADDRESS_KEY, addr);
          localStorage.setItem(OWNER_DID_KEY, signingMode.did);
          await identityService.setRegistry(registryDb);
          await selfRegisterDevice();
          console.log('[ui] New registry DB created:', addr, '— DID persisted:', signingMode.did);
          await initDeviceManager();
          return;
        } catch (retryErr) {
          console.warn('[ui] Failed to create new registry:', retryErr.message);
        }
      }
      console.warn('[ui] Failed to init registry DB:', err.message);
    }
  }

  async function initDeviceManager() {
    if (deviceManager) return;
    if (deviceManagerInitInProgress) return;
    if (!libp2p || !registryDb || !signingMode?.did) return;
    deviceManagerInitInProgress = true;
    try {
      const credential = loadWebAuthnCredentialSafe();
      deviceManager = await MultiDeviceManager.createFromExisting({
        credential,
        orbitdb,
        libp2p,
        identity: { id: signingMode.did, passkeyKind: passkeyKindFromSigningMode(signingMode) },
        onPairingRequest: async (request) => {
          pairingFlow(
            'ALICE',
            '[UI] onPairingRequest invoked — showing Storacha panel + passkeys tab',
            {
              fromDid: request?.identity?.id,
              deviceLabel: request?.identity?.deviceLabel,
            }
          );
          console.log(
            '[p2p] Pairing request from:',
            request?.identity?.id || request?.identity?.deviceLabel
          );
          showStoracha = true;
          activeTab = 'passkeys';
          onPairingPromptOpen();
          pairingFlow('ALICE', '[UI] waiting for user — Approve or Deny (promise pending)');
          return new Promise((resolve) => {
            pendingPairRequest = request;
            pendingPairResolve = resolve;
          });
        },
        onDeviceLinked: (device) => {
          devices = devices.filter((d) => d.ed25519_did !== device.ed25519_did);
          devices = [...devices, device];
        },
        onDeviceJoined: (peerId) => {
          console.log('[p2p] Peer joined:', peerId);
        },
      });
      const dbAddr = registryDb.address?.toString?.() || registryDb.address;
      if (dbAddr) await deviceManager.openExistingDb(dbAddr);

      devices = await deviceManager.listDevices();
      peerInfo = deviceManager.getPeerInfo();
      console.log('[ui] MultiDeviceManager initialized');
    } catch (err) {
      console.warn('[ui] Failed to init MultiDeviceManager:', err.message);
    } finally {
      deviceManagerInitInProgress = false;
    }
  }

  async function handleTabSwitch(tab) {
    activeTab = tab;
    if (tab === 'passkeys' && registryDb) {
      try {
        devices = await listRegistryDevices(registryDb);
      } catch (err) {
        console.warn('[ui] Failed to load devices:', err.message);
      }
    }
  }

  function handleCopyPeerInfo() {
    let id = null;
    if (deviceManager) {
      peerInfo = deviceManager.getPeerInfo();
      id = peerInfo?.peerId;
    } else if (libp2p) {
      id = libp2p.peerId.toString();
      peerInfo = { peerId: id, multiaddrs: libp2p.getMultiaddrs().map((ma) => ma.toString()) };
    }
    if (!id) return;
    navigator.clipboard.writeText(id);
    showMessage('Peer ID copied — paste it on the other device after both are connected via P2P.');
  }

  /** Plain peer id, or legacy JSON `{ "peerId", "multiaddrs"? }`. */
  function parseLinkPeerInput(raw) {
    const t = raw.trim();
    if (!t) throw new Error('Enter the other device’s peer id.');
    if (t.startsWith('{')) {
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        throw new Error('Invalid JSON. Paste a peer id, or legacy { "peerId", "multiaddrs" }.');
      }
      return MultiDeviceManager._normalizeLinkPayload(o);
    }
    return MultiDeviceManager._normalizeLinkPayload(t);
  }

  async function migrateRegistryEntries(oldDb, newDb, did) {
    // Read all entries from old DB once (stable — not being written to during migration)
    const keypairs = await listKeypairs(oldDb);
    const archive = await getArchiveEntry(oldDb, did);
    const delegations = await listDelegations(oldDb);

    if (keypairs.length === 0 && !archive && delegations.length === 0) {
      console.log('[ui] No entries to migrate');
      return true;
    }

    // Retry writes until ACL grant propagates from Device A
    const maxWait = 120000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        for (const kp of keypairs) {
          await storeKeypairEntry(newDb, kp.did, kp.publicKey);
        }
        if (archive) {
          await storeArchiveEntry(newDb, did, archive.ciphertext, archive.iv);
        }
        for (const d of delegations) {
          await storeDelegationEntry(
            newDb,
            d.delegation,
            d.space_did,
            d.label,
            d.stored_by_did
          );
        }
        console.log('[ui] Registry migration complete after', Date.now() - start, 'ms');
        return true;
      } catch (err) {
        if (!err.message?.includes('not allowed to write')) {
          console.warn('[ui] Registry migration error:', err.message);
          return false;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn('[ui] Registry migration timed out waiting for write access');
    return false;
  }

  async function handleLinkDevice() {
    if (!linkInput.trim()) {
      showMessage('Enter the other device’s peer id (copy from the P2P Passkeys tab).', 'error');
      return;
    }
    if (!deviceManager) {
      showMessage(
        'Device linking is not ready yet. Wait for OrbitDB and the registry to finish initializing, and ensure this app has a libp2p instance.',
        'error'
      );
      return;
    }
    isLinking = true;
    linkError = '';
    try {
      const payload = parseLinkPeerInput(linkInput);
      const result = await deviceManager.linkToDevice(payload);
      pairingFlow('BOB', '[UI] linkToDevice returned', {
        type: result?.type,
        reason: result?.reason,
      });
      if (result.type === 'granted') {
        const sharedAddr = result.dbAddress?.toString?.() || result.dbAddress;
        pairingFlow(
          'BOB',
          '[UI] granted — will migrate local registry entries then persist shared address',
          {
            sharedAddrPrefix: sharedAddr ? String(sharedAddr).slice(0, 48) + '…' : null,
          }
        );

        // Migrate Device B's entries to the shared registry before switching
        let migrated = false;
        if (registryDb && deviceManager.getDevicesDb() && signingMode?.did) {
          const sharedDb = deviceManager.getDevicesDb();
          console.log('[ui] Migrating entries from old registry to shared registry...');
          migrated = await migrateRegistryEntries(registryDb, sharedDb, signingMode.did);
        }

        // Only switch to shared registry if migration succeeded
        if (migrated && sharedAddr) {
          localStorage.setItem(REGISTRY_ADDRESS_KEY, sharedAddr);
          console.log('[ui] Persisted shared registry address from Device A:', sharedAddr);
        } else if (!migrated) {
          console.warn('[ui] Keeping old registry address — migration did not complete');
        }
        showMessage('Device linked successfully!');
        pairingFlow('BOB', '[UI] device link success message shown; device list refreshed');
        linkInput = '';
        devices = await deviceManager.listDevices();
      } else {
        pairingFlow('BOB', '[UI] link rejected by Alice', { reason: result.reason });
        linkError = result.reason || 'Link request was rejected';
      }
    } catch (err) {
      pairingFlow('BOB', '[UI] linkToDevice threw', { error: err?.message });
      linkError = `Failed to link: ${err.message}`;
    } finally {
      isLinking = false;
    }
  }

  function handlePairDecision(decision) {
    if (pendingPairResolve) {
      pairingFlow('ALICE', '[UI] user clicked pairing decision — resolving promise to handler', {
        decision,
      });
      pendingPairResolve(decision);
      pendingPairResolve = null;
      pendingPairRequest = null;
    } else {
      pairingFlow('ALICE', '[UI] handlePairDecision called but no pending pairing (ignored)', {
        decision,
      });
    }
  }

  function formatDelegationImportError(err) {
    const msg = err?.message || String(err);
    if (/atob|correctly encoded|base64/i.test(msg)) {
      return (
        'That text is not a valid UCAN delegation (base64 / CAR). ' +
        'Export a delegation from Storacha (e.g. w3up CLI or another browser that is already logged in) and paste it here. ' +
        'To link browsers over libp2p only, use the P2P Passkeys tab and paste the other device’s peer id — not this field.'
      );
    }
    return `Delegation import failed: ${msg}`;
  }

  async function handleImportDelegation() {
    if (!delegationText.trim()) {
      showMessage('Please paste a UCAN delegation', 'error');
      return;
    }
    isLoading = true;
    try {
      await handleConnectWithDelegation(delegationText.trim());
      delegationText = '';
    } catch (err) {
      showMessage(formatDelegationImportError(err), 'error');
    } finally {
      isLoading = false;
    }
  }

  async function handleConnectWithDelegation(delegationStr) {
    await connectStoracha(delegationStr, { store: true, storeRegistryDb: registryDb });
    showMessage('Connected to Storacha via UCAN delegation!');
    await handlePublishManifest();
  }

  function setupBridgeListeners() {
    if (!bridge) return;
    bridge.on('uploadProgress', (progress) => {
      progressType = 'upload';
      progressCurrent = progress.current;
      progressTotal = progress.total;
      progressPercentage = progress.percentage;
      progressCurrentBlock = progress.currentBlock;
      progressError = progress.error;
      showProgress = true;
    });
    bridge.on('downloadProgress', (progress) => {
      progressType = 'download';
      progressCurrent = progress.current;
      progressTotal = progress.total;
      progressPercentage = progress.percentage;
      progressCurrentBlock = progress.currentBlock;
      progressError = progress.error;
      showProgress = true;
    });
  }

  async function handleLogout() {
    isLoggedIn = false;
    client = null;
    currentSpace = null;
    spaceUsage = null;
    signingMode = null;
    await clearStoredDelegation(registryDb);
    if (bridge) {
      bridge.removeAllListeners();
      bridge = null;
    }
    resetProgress();
    showMessage('Logged out successfully');
  }

  async function loadSpaceUsage() {
    if (!client) return;
    try {
      spaceUsage = await getSpaceUsage(client);
    } catch (err) {
      console.warn('Failed to load space usage info:', err.message);
      spaceUsage = null;
    }
  }

  async function handleBackup() {
    if (!bridge) {
      showMessage('Please log in first', 'error');
      return;
    }

    const hasDatabase = database && entryCount > 0;
    const hasRegistry = !!registryDb;

    if (!hasDatabase && !hasRegistry) {
      showMessage('No data to backup', 'error');
      return;
    }

    isLoading = true;
    resetProgress();

    try {
      // Backup user database if available
      if (hasDatabase) {
        const result = await bridge.backup(orbitdb, database.address);

        if (result.success) {
          showMessage(
            `Backup completed! ${result.blocksUploaded}/${result.blocksTotal} blocks uploaded`
          );
          onBackup(result);
        } else {
          showMessage(result.error, 'error');
          return;
        }
      }

      // Backup registry DB
      if (hasRegistry) {
        try {
          const regResult = await backupRegistryDb(bridge, orbitdb, registryDb);
          console.log('[ui] Registry DB backed up:', regResult);
          if (!hasDatabase) {
            showMessage('Registry backup completed!');
          }
        } catch (err) {
          console.warn('[ui] Registry backup failed:', err.message);
        }
      }

      await handlePublishManifest();
    } catch (err) {
      showMessage(`Backup failed: ${err.message}`, 'error');
    } finally {
      isLoading = false;
      resetProgress();
    }
  }

  async function restoreFromSpaceFallback() {
    if (!orbitdb) {
      showMessage('OrbitDB not initialized. Please wait for initialization to complete.', 'error');
      return;
    }

    isLoading = true;
    resetProgress();

    try {
      // Close existing database if provided
      if (database) {
        try {
          await database.close();
        } catch {
          // Continue even if close fails
        }
      }

      if (!bridge) {
        throw new Error('Bridge not initialized. Please connect to Storacha first.');
      }

      const result = await bridge.restoreFromSpace(orbitdb, {
        timeout: 120000,
        preferredDatabaseName: databaseName,
        restartAfterRestore: true,
        verifyIntegrity: true,
      });

      if (result.success) {
        showMessage(`Restore completed! ${result.entriesRecovered} entries recovered.`);
        onRestore(result.database);
      } else {
        showMessage(`Restore failed: ${result.error}`, 'error');
      }
    } catch (err) {
      showMessage(`Restore failed: ${err.message}`, 'error');
    } finally {
      isLoading = false;
      resetProgress();
    }
  }

  function formatRelativeTime(dateString) {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
    if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
    return `${Math.floor(diffInSeconds / 31536000)} years ago`;
  }

  function formatSpaceName(space) {
    return space.name === 'Unnamed Space' ? `Space ${space.did.slice(-8)}` : space.name;
  }

  onMount(async () => {
    localPasskeyDetected = hasLocalPasskeyHint();

    // Try to reopen registry DB from stored address
    if (orbitdb) {
      const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
      if (storedAddr) {
        try {
          registryDb = await openDeviceRegistry(orbitdb, null, storedAddr);
          console.log('[ui] Reopened registry DB from stored address');
        } catch (err) {
          console.warn('[ui] Failed to reopen registry:', err.message);
        }
      }
    }

    // Check for stored signing mode (no biometric needed)
    const stored = identityService.getSigningMode();
    if (stored.mode) {
      signingMode = stored;
    }
    // Don't auto-connect — user must click "Authenticate" which may prompt biometric
  });
</script>

{#snippet pairingApprovalPrompt()}
  {#if pendingPairRequest}
    <div
      data-testid="storacha-pairing-prompt"
      style="border-radius: 0.375rem; border: 2px solid #FFC83F; background: linear-gradient(to bottom right, #ffffff, #FFF8E1); padding: 1rem; box-shadow: 0 4px 12px rgba(233, 19, 21, 0.15);"
    >
      <h4
        style="margin: 0 0 0.5rem 0; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; font-size: 0.875rem;"
      >
        Device Pairing Request
      </h4>
      <p
        style="margin: 0 0 0.5rem 0; font-size: 0.75rem; color: #374151; font-family: 'DM Sans', sans-serif; line-height: 1.4;"
      >
        A device wants to link to your account:
      </p>
      <div
        style="background: rgba(233, 19, 21, 0.04); border-radius: 0.25rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem;"
      >
        <div style="font-size: 0.7rem; color: #6b7280; font-family: 'DM Sans', sans-serif;">
          <strong>Device:</strong>
          {pendingPairRequest.identity?.deviceLabel || 'Unknown'}
        </div>
        <div
          style="font-size: 0.65rem; color: #9ca3af; font-family: 'DM Mono', monospace; margin-top: 0.25rem; word-break: break-all;"
        >
          {pendingPairRequest.identity?.id
            ? pendingPairRequest.identity.id.slice(0, 20) +
              '...' +
              pendingPairRequest.identity.id.slice(-8)
            : 'N/A'}
        </div>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button
          data-testid="storacha-pairing-approve"
          onclick={() => handlePairDecision('granted')}
          style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 700; font-size: 0.8rem;"
        >
          Approve
        </button>
        <button
          data-testid="storacha-pairing-deny"
          onclick={() => handlePairDecision('rejected')}
          style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; background: transparent; color: #dc2626; border: 1px solid #dc2626; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 700; font-size: 0.8rem;"
        >
          Deny
        </button>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet linkedDevicesPanel()}
  <div
    style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 0.75rem;"
  >
    <div
      style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;"
    >
      <div
        style="font-size: 0.65rem; font-weight: 700; color: #E91315; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'DM Sans', sans-serif;"
      >
        Linked Devices
      </div>
      <div
        style="display: flex; align-items: center; gap: 0.25rem; background: #FFC83F; padding: 0.125rem 0.5rem; border-radius: 9999px;"
      >
        <span
          style="font-size: 0.7rem; font-weight: 700; color: #111827; font-family: 'DM Mono', monospace;"
          >{devices.length}</span
        >
      </div>
    </div>
    {#if devices.length === 0}
      <div
        style="text-align: center; padding: 1rem; font-size: 0.8rem; color: #9ca3af; font-family: 'DM Sans', sans-serif;"
      >
        No devices linked yet
      </div>
    {:else}
      <div style="display: flex; flex-direction: column; gap: 0.375rem;">
        {#each devices as device, i (device.credential_id || device.ed25519_did || device.device_label || i)}
          {@const passkeyBadge = linkedDevicePasskeyLabel(device)}
          <div
            data-testid="storacha-linked-device-row"
            data-device-label={device.device_label || ''}
            style="display: flex; align-items: flex-start; gap: 0.625rem; padding: 0.5rem; border-radius: 0.375rem; background: rgba(255, 255, 255, 0.7); border-left: 3px solid {device.status ===
            'active'
              ? '#10b981'
              : '#E91315'};"
          >
            <div style="font-size: 1rem; flex-shrink: 0;">
              {linkedDeviceIcon(device.device_label)}
            </div>
            <div style="flex: 1; min-width: 0;">
              <div
                style="font-size: 0.8rem; font-weight: 600; color: #1f2937; font-family: 'DM Sans', sans-serif;"
              >
                {device.device_label || 'Unknown Device'}
              </div>
              <code style="font-size: 0.625rem; color: #6B7280; font-family: 'DM Mono', monospace;">
                {device.ed25519_did
                  ? device.ed25519_did.slice(0, 16) + '...' + device.ed25519_did.slice(-8)
                  : 'N/A'}
              </code>
              <div
                style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.35rem; align-items: center;"
              >
                {#if passkeyBadge}
                  <span
                    style="font-size: 0.55rem; font-weight: 600; padding: 0.1rem 0.35rem; border-radius: 9999px; background: #e0e7ff; color: #3730a3; font-family: 'DM Mono', monospace;"
                    title="Passkey signing mode for this device"
                  >
                    {passkeyBadge}
                  </span>
                {/if}
                {#if device.ed25519_did && (ucanCountsByDid[device.ed25519_did] ?? 0) > 0}
                  <span
                    style="font-size: 0.55rem; font-weight: 600; padding: 0.1rem 0.35rem; border-radius: 9999px; background: #fef3c7; color: #92400e; font-family: 'DM Sans', sans-serif;"
                    title={ucanTooltipByDid[device.ed25519_did]?.trim()
                      ? ucanTooltipByDid[device.ed25519_did]
                      : 'UCAN delegations on this device (parsing summary…)'}
                  >
                    {ucanCountsByDid[device.ed25519_did]}
                    {ucanCountsByDid[device.ed25519_did] === 1 ? ' UCAN' : ' UCANs'}
                  </span>
                {/if}
              </div>
            </div>
            <div
              style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; flex-shrink: 0;"
            >
              <span
                style="font-size: 0.6rem; font-weight: 600; padding: 0.125rem 0.375rem; border-radius: 9999px; background: {device.status ===
                'active'
                  ? '#dcfce7'
                  : '#fee2e2'}; color: {device.status === 'active'
                  ? '#166534'
                  : '#991b1b'}; font-family: 'DM Sans', sans-serif;"
              >
                {device.status}
              </span>
              <button
                type="button"
                data-testid="storacha-linked-device-remove"
                aria-label="Remove linked device"
                onclick={() => confirmRemoveLinkedDevice(device)}
                style="font-size: 0.6rem; font-weight: 600; padding: 0.15rem 0.4rem; border-radius: 0.25rem; background: transparent; color: #b91c1c; border: 1px solid #fca5a5; cursor: pointer; font-family: 'DM Sans', sans-serif;"
              >
                Remove
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div
  data-testid="storacha-panel"
  class="storacha-panel"
  style="max-height: 70vh; overflow-y: auto; border-radius: 0.75rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #FFE4AE, #EFE3F3); padding: 1rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
>
  <!-- Header -->
  <div
    style="margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(233, 19, 21, 0.2); padding-bottom: 0.75rem;"
  >
    <div style="display: flex; align-items: center; gap: 0.75rem;">
      <div
        style="border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.2); background-color: #ffffff; padding: 0.5rem; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);"
      >
        <svg
          width="20"
          height="22"
          viewBox="0 0 154 172"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M110.999 41.5313H71.4081C70.2881 41.5313 69.334 42.4869 69.334 43.6087V154.359C69.334 159.461 69.1847 164.596 69.334 169.698C69.334 169.773 69.334 169.839 69.334 169.914C69.334 171.036 70.2881 171.992 71.4081 171.992H111.646C112.766 171.992 113.72 171.036 113.72 169.914V129.613L111.646 131.69H151.884C153.004 131.69 153.959 130.735 153.959 129.613V95.7513C153.959 91.6796 154.041 87.5996 153.942 83.5362C153.685 72.9996 149.512 62.8038 142.318 55.1091C135.125 47.4144 125.319 42.7029 114.907 41.7141C113.604 41.5894 112.302 41.5313 110.991 41.5313C108.319 41.523 108.319 45.6777 110.991 45.6861C120.772 45.7193 130.305 49.4171 137.457 56.1229C144.608 62.8287 149.022 71.9443 149.702 81.6416C149.993 85.813 149.802 90.0592 149.802 94.2306V124.677C149.802 126.231 149.694 127.826 149.802 129.38C149.802 129.455 149.802 129.53 149.802 129.604L151.876 127.527H111.638C110.518 127.527 109.564 128.483 109.564 129.604V169.906L111.638 167.829H71.3998L73.474 169.906V48.7689C73.474 47.1319 73.5818 45.4617 73.474 43.8247C73.474 43.7499 73.474 43.6834 73.474 43.6087L71.3998 45.6861H110.991C113.662 45.6861 113.662 41.5313 110.991 41.5313H110.999Z"
            fill="#E91315"
          />
          <path
            d="M108.519 68.9694C108.452 62.9532 104.727 57.66 99.1103 55.5494C93.4935 53.4387 87.0886 55.2669 83.3718 59.779C79.5554 64.4157 78.9165 71.0966 82.0277 76.2901C85.1389 81.4836 91.2037 84.0762 97.1025 82.9544C103.723 81.6996 108.444 75.617 108.527 68.9694C108.56 66.2937 104.412 66.2937 104.379 68.9694C104.329 73.1325 101.749 77.0878 97.7579 78.4838C93.7673 79.8798 89.03 78.6749 86.3087 75.2265C83.5875 71.778 83.4879 67.2077 85.6865 63.6346C87.8851 60.0615 92.2076 58.1752 96.2811 59.0477C100.985 60.0532 104.32 64.1664 104.379 68.9777C104.412 71.6533 108.56 71.6533 108.527 68.9777L108.519 68.9694Z"
            fill="#E91315"
          />
          <path
            d="M94.265 73.3237C96.666 73.3237 98.6124 71.3742 98.6124 68.9695C98.6124 66.5647 96.666 64.6152 94.265 64.6152C91.8641 64.6152 89.9177 66.5647 89.9177 68.9695C89.9177 71.3742 91.8641 73.3237 94.265 73.3237Z"
            fill="#E91315"
          />
          <path
            d="M71.4081 36.8029H132.429C144.642 36.8029 150.64 28.5764 151.752 23.8981C152.863 19.2281 147.263 7.43685 133.624 22.1199C133.624 22.1199 141.754 6.32336 130.869 2.76686C119.984 -0.789637 107.473 10.1042 102.512 20.5577C102.512 20.5577 103.109 7.6529 91.8923 10.769C80.6754 13.8851 71.4081 36.7946 71.4081 36.7946V36.8029Z"
            fill="#E91315"
          />
          <path
            d="M18.186 66.1195C17.879 66.0531 17.8707 65.6126 18.1694 65.5212C31.6927 61.4246 42.2376 70.7895 46.0457 76.6312C48.3189 80.1212 51.6956 83.3868 54.1182 85.5058C55.4042 86.6276 55.0889 88.7216 53.5292 89.4113C52.4589 89.8849 50.7498 90.9402 49.2316 91.846C46.3859 93.5495 42.4699 100.554 33.0948 101.884C26.1921 102.856 17.6716 98.7014 13.6561 96.4329C13.3408 96.2584 13.5399 95.793 13.8884 95.8761C19.8536 97.3137 24.2673 94.8291 22.4753 91.5302C21.1395 89.0706 17.5223 88.1482 12.2789 90.2339C7.61621 92.087 2.07414 86.0376 0.597357 84.2843C0.439724 84.1015 0.555875 83.8106 0.788177 83.7857C5.16044 83.3453 9.41656 78.8664 12.2291 74.1715C14.801 69.8755 20.5837 69.4849 22.4255 69.4683C22.6744 69.4683 22.8154 69.1858 22.6661 68.9863C22.0605 68.1886 20.6169 66.6513 18.186 66.1112V66.1195ZM30.1413 87.9571C29.7264 87.9322 29.4692 88.3975 29.7181 88.7299C30.7967 90.1342 33.5345 92.5855 38.7448 90.9818C45.8134 88.8047 46.1038 84.3175 40.9516 80.3455C36.4798 76.9054 29.2204 77.5618 24.8647 79.8968C24.4084 80.1461 24.5992 80.8441 25.1136 80.8026C26.8641 80.6696 30.133 80.8607 32.0827 82.2401C34.7126 84.0932 35.617 88.331 30.1413 87.9654V87.9571Z"
            fill="#E91315"
          />
        </svg>
      </div>
      <div>
        <h3
          style="font-size: 1.125rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
        >
          P2Pass
        </h3>
        <p
          style="font-size: 0.6875rem; color: #555; font-family: 'DM Mono', monospace; line-height: 1.35; max-width: 18rem;"
        >
          peer-to-peer passkeys and ucans
        </p>
      </div>
    </div>

    <button
      class="storacha-toggle"
      onclick={() => (showStoracha = !showStoracha)}
      style="border-radius: 0.5rem; padding: 0.5rem; color: #E91315; transition: color 150ms, background-color 150ms; border: none; background: transparent; cursor: pointer;"
      title={showStoracha ? 'Collapse' : 'Expand'}
      aria-label={showStoracha ? 'Collapse P2Pass panel' : 'Expand P2Pass panel'}
    >
      <svg
        style="height: 1rem; width: 1rem; transition: transform 200ms; transform: {showStoracha
          ? 'rotate(180deg)'
          : 'rotate(0deg)'};"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  </div>

  {#if showStoracha}
    <!-- OrbitDB Initialization Status -->
    {#if !isInitialized}
      <div
        style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(217, 169, 56, 0.4); background: linear-gradient(to right, #fff8e1, #fffde7, #fff3e0); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
      >
        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
          <div
            style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #FFC83F, #e67e22); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
          >
            <Loader2
              style="height: 1rem; width: 1rem; color: #ffffff; animation: spin 1s linear infinite;"
            />
          </div>
          <div style="flex: 1; font-size: 0.875rem;">
            <div style="font-weight: 600; color: #78350f; font-family: 'Epilogue', sans-serif;">
              Database Initializing
            </div>
            <div
              style="margin-top: 0.25rem; color: rgba(120, 53, 15, 0.9); font-family: 'DM Sans', sans-serif;"
            >
              OrbitDB is still setting up. You can login to Storacha now, but backup & restore will
              be available once initialization completes.
            </div>
            <div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
              <div
                style="height: 0.375rem; width: 6rem; border-radius: 9999px; background-color: #fde68a;"
              >
                <div
                  style="height: 100%; width: 75%; border-radius: 9999px; background: linear-gradient(to right, #FFC83F, #e67e22); animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;"
                ></div>
              </div>
              <span style="font-size: 0.75rem; color: #92400e; font-family: 'DM Mono', monospace;"
                >Please wait...</span
              >
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Status Messages -->
    {#if error}
      <div
        style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.4); background: linear-gradient(to right, #fef2f2, #fdf2f8, #fff1f2); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
      >
        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
          <div
            style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #E91315, #be123c); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
          >
            <AlertCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
          </div>
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #7f1d1d; font-family: 'Epilogue', sans-serif;">
              Error
            </div>
            <div
              style="margin-top: 0.25rem; font-size: 0.875rem; color: rgba(127, 29, 29, 0.9); font-family: 'DM Sans', sans-serif;"
            >
              {error}
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if success}
      <div
        style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(16, 185, 129, 0.4); background: linear-gradient(to right, #ecfdf5, #f0fdf4, #f0fdfa); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
      >
        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
          <div
            style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #10b981, #14b8a6); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
          >
            <CheckCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
          </div>
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #064e3b; font-family: 'Epilogue', sans-serif;">
              Success
            </div>
            <div
              style="margin-top: 0.25rem; font-size: 0.875rem; color: rgba(6, 78, 59, 0.9); font-family: 'DM Sans', sans-serif;"
            >
              {success}
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Progress Bar -->
    {#if showProgress}
      <div
        style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.3); background: linear-gradient(to right, #FFF5E6, #FFF0F0, #FFF5E6); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
      >
        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
          <div
            style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #E91315, #FFC83F); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
          >
            <svg
              style="height: 1rem; width: 1rem; color: #ffffff; animation: spin 1s linear infinite;"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </div>
          <div style="flex: 1;">
            <div
              style="margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between;"
            >
              <span style="font-weight: 600; color: #7A1518; font-family: 'Epilogue', sans-serif;">
                {progressType === 'upload' ? 'Uploading' : 'Downloading'} Progress
              </span>
              <span
                style="font-size: 0.875rem; font-weight: 500; color: #E91315; font-family: 'DM Mono', monospace;"
              >
                {progressPercentage}% ({progressCurrent}/{progressTotal})
              </span>
            </div>
            <div
              style="height: 0.75rem; width: 100%; border-radius: 9999px; background-color: #FFE4AE; box-shadow: inset 0 2px 4px 0 rgba(0,0,0,0.05);"
            >
              <div
                style="height: 0.75rem; border-radius: 9999px; background: linear-gradient(to right, #E91315, #FFC83F, #E91315); box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05); transition: all 500ms ease-out; width: {progressPercentage}%"
              ></div>
            </div>
            {#if progressCurrentBlock}
              <div
                style="margin-top: 0.5rem; font-size: 0.75rem; color: rgba(122, 21, 24, 0.8); font-family: 'DM Mono', monospace;"
              >
                {progressType === 'upload' ? 'Current block:' : 'Current CID:'}
                <span style="font-weight: 500;">
                  {progressType === 'upload'
                    ? progressCurrentBlock.hash?.slice(0, 16)
                    : progressCurrentBlock.storachaCID?.slice(0, 16)}...
                </span>
              </div>
            {/if}
            {#if progressError}
              <div
                style="margin-top: 0.5rem; border-radius: 0.375rem; background-color: #fee2e2; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #b91c1c; font-family: 'DM Sans', sans-serif;"
              >
                Error: {progressError.message}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Pairing prompt: mounted outside tab panels so it always shows (snippet renders nothing when idle). -->
    {@render pairingApprovalPrompt()}

    {#if !isLoggedIn}
      <!-- Login Section -->
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div
          style="text-align: center; font-size: 0.875rem; color: #374151; font-family: 'DM Sans', sans-serif;"
        >
          Create, use and replicate your passkeys and UCANs between your devices - recover them from
          decentralised Filecoin/Storacha storage
        </div>

        {#if !signingMode}
          <!-- Step 1: passkey — labels follow hasLocalPasskeyHint() + registry -->
          <div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem;">
            <div
              style="text-align: center; font-size: 0.75rem; color: #6b7280; font-family: 'DM Sans', sans-serif;"
            >
              {passkeyStepHint}
            </div>

            <fieldset
              disabled={isAuthenticating || signingPreferenceOverride != null}
              data-testid="storacha-signing-preference-group"
              style="margin: 0; width: 100%; max-width: 22rem; border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.25); padding: 0.625rem 0.75rem; background: rgba(255, 255, 255, 0.6); box-sizing: border-box;"
            >
              <legend
                style="font-size: 0.7rem; font-weight: 600; color: #374151; font-family: 'Epilogue', sans-serif; padding: 0 0.25rem;"
              >
                Signing mode
              </legend>
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                <label
                  style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer; font-size: 0.68rem; color: #374151; font-family: 'DM Sans', sans-serif; line-height: 1.35;"
                >
                  <input
                    type="radio"
                    name="storacha-signing-pref"
                    data-testid="storacha-signing-pref-hardware-ed25519"
                    checked={selectedSigningPreference === 'hardware-ed25519'}
                    onchange={() => setSigningPreference('hardware-ed25519')}
                    style="margin-top: 0.15rem; accent-color: #E91315;"
                  />
                  <span
                    ><strong>Hardware Ed25519</strong> (default) — passkey signatures in the secure
                    element; Ed25519 preferred, <strong>P-256 fallback</strong> if the authenticator does
                    not support Ed25519.</span
                  >
                </label>
                <label
                  style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer; font-size: 0.68rem; color: #374151; font-family: 'DM Sans', sans-serif; line-height: 1.35;"
                >
                  <input
                    type="radio"
                    name="storacha-signing-pref"
                    data-testid="storacha-signing-pref-hardware-p256"
                    checked={selectedSigningPreference === 'hardware-p256'}
                    onchange={() => setSigningPreference('hardware-p256')}
                    style="margin-top: 0.15rem; accent-color: #E91315;"
                  />
                  <span
                    ><strong>Hardware P-256</strong> — WebAuthn ES256 only (no Ed25519 on this passkey).</span
                  >
                </label>
                <label
                  style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer; font-size: 0.68rem; color: #374151; font-family: 'DM Sans', sans-serif; line-height: 1.35;"
                >
                  <input
                    type="radio"
                    name="storacha-signing-pref"
                    data-testid="storacha-signing-pref-worker"
                    checked={selectedSigningPreference === 'worker'}
                    onchange={() => setSigningPreference('worker')}
                    style="margin-top: 0.15rem; accent-color: #E91315;"
                  />
                  <span
                    ><strong>Worker Ed25519</strong> — signing key in a web worker; WebAuthn used for
                    PRF / user verification (recommended for OrbitDB multi-device).</span
                  >
                </label>
              </div>
            </fieldset>

            {#if !localPasskeyDetected}
              <label
                style="display: flex; width: 100%; max-width: 22rem; flex-direction: column; align-items: stretch; gap: 0.35rem; text-align: left; box-sizing: border-box;"
              >
                <span
                  style="font-size: 0.7rem; font-weight: 600; color: #374151; font-family: 'Epilogue', sans-serif;"
                >
                  Passkey name (WebAuthn user ID)
                </span>
                <input
                  type="text"
                  data-testid="storacha-passkey-user-label"
                  bind:value={passkeyUserLabel}
                  disabled={isAuthenticating || signingPreferenceOverride != null}
                  placeholder="e.g. Work laptop"
                  autocomplete="username"
                  style="width: 100%; box-sizing: border-box; border-radius: 0.375rem; border: 1px solid rgba(233, 19, 21, 0.25); padding: 0.5rem 0.625rem; font-size: 0.8rem; font-family: 'DM Sans', sans-serif; color: #111827; background: rgba(255, 255, 255, 0.9);"
                />
                <span
                  style="font-size: 0.65rem; color: #6b7280; font-family: 'DM Sans', sans-serif; line-height: 1.35;"
                >
                  Optional. Used for user.id (and display name) when creating a new passkey. Leave blank for an
                  anonymous default.
                </span>
              </label>
            {/if}

            <button
              data-testid="storacha-passkey-primary"
              class="storacha-btn-primary"
              onclick={handleAuthenticate}
              disabled={isAuthenticating}
              style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.625rem 1.5rem; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; font-size: 0.875rem; opacity: {isAuthenticating
                ? '0.5'
                : '1'};"
            >
              {#if isAuthenticating}
                <Loader2 style="height: 1rem; width: 1rem; animation: spin 1s linear infinite;" />
                <span>{primaryPasskeyLoadingLabel}</span>
              {:else}
                <svg
                  style="height: 1rem; width: 1rem;"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"
                  />
                </svg>
                <span>{primaryPasskeyLabel}</span>
              {/if}
            </button>

            <!-- Recover from backup (IPNS / manifest) -->
            <button
              data-testid="storacha-recover-passkey"
              onclick={handleRecover}
              disabled={isRecovering}
              style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: transparent; padding: 0.5rem 1.25rem; color: #E91315; border: 1px solid #E91315; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; font-size: 0.75rem; opacity: {isRecovering
                ? '0.5'
                : '1'}; transition: background-color 150ms;"
            >
              {#if isRecovering}
                <Loader2
                  style="height: 0.875rem; width: 0.875rem; animation: spin 1s linear infinite;"
                />
                <span>{recoveryStatus || 'Recovering...'}</span>
              {:else}
                <svg
                  style="height: 0.875rem; width: 0.875rem;"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                <span>Recover Passkey</span>
              {/if}
            </button>
          </div>
        {:else}
          <!-- Step 2: Authenticated — show DID info + delegation import -->
          <div
            data-testid="storacha-post-auth"
            style="display: flex; flex-direction: column; gap: 0.75rem;"
          >
            <!-- Signing Mode Badge -->
            <div
              style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; flex-wrap: wrap;"
            >
              {#if signingMode.algorithm === 'Ed25519' && signingMode.mode === 'hardware'}
                <span
                  style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #dcfce7; border: 1px solid #86efac; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #166534; font-family: 'DM Sans', sans-serif;"
                >
                  <svg
                    style="height: 0.625rem; width: 0.625rem;"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    ><path
                      fill-rule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clip-rule="evenodd"
                    /></svg
                  >
                  Hardware Ed25519
                </span>
              {:else if signingMode.algorithm === 'P-256' && signingMode.mode === 'hardware'}
                <span
                  style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #BDE0FF; border: 1px solid #0176CE; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #0176CE; font-family: 'DM Sans', sans-serif;"
                >
                  <svg
                    style="height: 0.625rem; width: 0.625rem;"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    ><path
                      fill-rule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clip-rule="evenodd"
                    /></svg
                  >
                  Hardware P-256
                </span>
              {:else}
                <span
                  style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #FFE4AE; border: 1px solid #FFC83F; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #92400e; font-family: 'DM Sans', sans-serif;"
                >
                  <svg
                    style="height: 0.625rem; width: 0.625rem;"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    ><path
                      fill-rule="evenodd"
                      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                      clip-rule="evenodd"
                    /></svg
                  >
                  Worker Ed25519
                </span>
              {/if}
              {#if signingMode.secure}
                <span
                  style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #dcfce7; border: 1px solid #86efac; padding: 0.25rem 0.5rem; font-size: 0.625rem; font-weight: 500; color: #166534; font-family: 'DM Mono', monospace;"
                >
                  Secure
                </span>
              {/if}
            </div>

            <!-- DID Display -->
            <div
              style="border-radius: 0.375rem; border: 1px solid rgba(233, 19, 21, 0.3); background: linear-gradient(to right, #ffffff, #EFE3F3); padding: 0.625rem 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);"
            >
              <div
                style="font-size: 0.625rem; font-weight: 600; color: #6b7280; font-family: 'DM Sans', sans-serif; margin-bottom: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em;"
              >
                Your DID
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <code
                  style="flex: 1; font-size: 0.75rem; color: #374151; font-family: 'DM Mono', monospace; word-break: break-all; line-height: 1.4;"
                >
                  {signingMode.did
                    ? signingMode.did.length > 40
                      ? signingMode.did.slice(0, 20) + '...' + signingMode.did.slice(-16)
                      : signingMode.did
                    : 'N/A'}
                </code>
                <button
                  class="storacha-btn-icon"
                  onclick={() => {
                    if (signingMode.did) {
                      navigator.clipboard.writeText(signingMode.did);
                      showMessage('DID copied to clipboard!');
                    }
                  }}
                  style="border-radius: 0.25rem; padding: 0.25rem; color: #0176CE; transition: all 150ms; border: none; background: transparent; cursor: pointer; flex-shrink: 0;"
                  title="Copy full DID"
                  aria-label="Copy DID to clipboard"
                >
                  <svg
                    style="height: 0.875rem; width: 0.875rem;"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {#if activeTab !== 'passkeys'}
              <!-- Delegation Import -->
              <div
                style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #EFE3F3); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
              >
                <h4
                  style="margin-bottom: 0.5rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; font-size: 0.875rem;"
                >
                  Import UCAN Delegation
                </h4>
                <p
                  style="margin-bottom: 0.75rem; font-size: 0.75rem; color: #6b7280; font-family: 'DM Sans', sans-serif; line-height: 1.4;"
                >
                  Paste a <strong>Storacha UCAN delegation</strong> (from w3up, the CLI, or copied
                  from a browser that already has access) to reach your space. This is not for
                  linking devices over libp2p — use the <strong>P2P Passkeys</strong> tab and peer JSON
                  for that.
                </p>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  <textarea
                    class="storacha-textarea"
                    data-testid="storacha-delegation-textarea"
                    bind:value={delegationText}
                    placeholder="Paste your UCAN delegation here (base64 encoded)..."
                    rows="4"
                    style="width: 100%; resize: none; border-radius: 0.375rem; border: 1px solid #E91315; background-color: #ffffff; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #111827; font-family: 'DM Mono', monospace; outline: none; box-sizing: border-box;"
                  ></textarea>
                  <button
                    class="storacha-btn-primary"
                    data-testid="storacha-delegation-import"
                    onclick={handleImportDelegation}
                    disabled={isLoading || !delegationText.trim()}
                    style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.5rem 1rem; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; opacity: {isLoading ||
                    !delegationText.trim()
                      ? '0.5'
                      : '1'}; box-sizing: border-box;"
                  >
                    {#if isLoading}
                      <Loader2
                        style="height: 1rem; width: 1rem; animation: spin 1s linear infinite;"
                      />
                      <span>Connecting...</span>
                    {:else}
                      <svg
                        style="height: 1rem; width: 1rem;"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                        />
                      </svg>
                      <span>Connect</span>
                    {/if}
                  </button>
                </div>
              </div>
            {:else}
              <!-- Link Device (peer id) -->
              <div
                style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
              >
                <h4
                  style="margin-bottom: 0.5rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; font-size: 0.875rem;"
                >
                  Link Another Device
                </h4>
                <p
                  style="margin-bottom: 0.75rem; font-size: 0.75rem; color: #6b7280; font-family: 'DM Sans', sans-serif; line-height: 1.4;"
                >
                  After both browsers are on the same app and P2P has discovered peers (pubsub),
                  paste the other device’s <strong>peer id</strong> (copy from its Passkeys tab). Linking
                  uses addresses libp2p already learned — no JSON.
                </p>
                {#if !linkDeviceReady}
                  <div
                    style="margin-bottom: 0.5rem; font-size: 0.7rem; color: #b45309; font-family: 'DM Sans', sans-serif; line-height: 1.35; border-radius: 0.375rem; background: rgba(254, 243, 199, 0.9); padding: 0.5rem 0.65rem; border: 1px solid #fbbf24;"
                  >
                    Linking is unavailable until the device registry and P2P stack finish loading
                    (MultiDeviceManager). If this stays stuck, check the browser console and confirm
                    OrbitDB initialized after passkey auth.
                  </div>
                {/if}
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  <input
                    type="text"
                    data-testid="storacha-link-peer-input"
                    bind:value={linkInput}
                    placeholder="Other device’s libp2p peer id (12D3KooW…)"
                    autocomplete="off"
                    spellcheck="false"
                    style="width: 100%; border-radius: 0.375rem; border: 1px solid #E91315; background-color: #ffffff; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #111827; font-family: 'DM Mono', monospace; outline: none; box-sizing: border-box;"
                  />
                  {#if linkError}
                    <div
                      data-testid="storacha-link-error"
                      style="font-size: 0.7rem; color: #dc2626; font-family: 'DM Sans', sans-serif;"
                    >
                      {linkError}
                    </div>
                  {/if}
                  <button
                    data-testid="storacha-link-device-submit"
                    data-mdm-ready={linkDeviceReady ? 'true' : 'false'}
                    type="button"
                    onclick={handleLinkDevice}
                    disabled={linkDeviceDisabled}
                    title={!linkDeviceReady
                      ? 'Waiting for device registry / MultiDeviceManager to initialize'
                      : 'Link using the other device’s peer id'}
                    style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.5rem 1rem; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: {linkDeviceDisabled
                      ? 'not-allowed'
                      : 'pointer'}; font-family: 'Epilogue', sans-serif; font-weight: 600; opacity: {linkDeviceDisabled
                      ? '0.5'
                      : '1'}; box-sizing: border-box;"
                  >
                    {#if isLinking}
                      <Loader2
                        style="height: 1rem; width: 1rem; animation: spin 1s linear infinite;"
                      />
                      <span>Linking...</span>
                    {:else}
                      <svg
                        style="height: 1rem; width: 1rem;"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                        />
                      </svg>
                      <span>Link Device</span>
                    {/if}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        {#if signingMode}
          <!-- Tab Navigation (visible after authentication) — P2P Passkeys first -->
          <div
            style="border-radius: 0.5rem; background: rgba(233, 19, 21, 0.06); padding: 0.25rem; display: flex; gap: 0.25rem;"
          >
            <button
              data-testid="storacha-tab-passkeys"
              onclick={() => handleTabSwitch('passkeys')}
              style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab ===
              'passkeys'
                ? 'linear-gradient(135deg, #E91315, #FFC83F)'
                : 'transparent'}; color: {activeTab === 'passkeys'
                ? '#fff'
                : '#6B7280'}; box-shadow: {activeTab === 'passkeys'
                ? '0 2px 8px rgba(233, 19, 21, 0.3)'
                : 'none'};"
            >
              P2P Passkeys
            </button>
            <button
              data-testid="storacha-tab-storacha"
              onclick={() => handleTabSwitch('storacha')}
              style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab ===
              'storacha'
                ? 'linear-gradient(135deg, #E91315, #FFC83F)'
                : 'transparent'}; color: {activeTab === 'storacha'
                ? '#fff'
                : '#6B7280'}; box-shadow: {activeTab === 'storacha'
                ? '0 2px 8px rgba(233, 19, 21, 0.3)'
                : 'none'};"
            >
              Storacha
            </button>
          </div>

          {#if activeTab === 'passkeys'}
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
              <!-- Connection Status + Copy -->
              <div
                style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #ffffff, #FFE4AE); padding: 0.625rem 0.75rem;"
              >
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 0.25rem;">
                      <div
                        style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background: {p2pLedDotBg}; box-shadow: {p2pLedShadow}; animation: {p2pLedPulse
                          ? 'pulse 2s infinite'
                          : 'none'};"
                      ></div>
                      {#if libp2p}
                        <span
                          data-testid="storacha-p2p-remote-peer-count"
                          title="Connected libp2p peers"
                          style="font-size: 0.65rem; font-weight: 700; font-family: 'DM Mono', monospace; color: {p2pLedTextColor}; line-height: 1; min-width: 0.65rem; text-align: center;"
                          >{p2pRemotePeerCount}</span
                        >
                      {/if}
                    </div>
                    <span
                      style="font-size: 0.75rem; font-weight: 600; color: {p2pLedTextColor}; font-family: 'Epilogue', sans-serif;"
                    >
                      {p2pConnectionLabel}
                    </span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 0.375rem;">
                    {#if libp2p}
                      <code
                        style="font-size: 0.6rem; color: #E91315; font-family: 'DM Mono', monospace; background: rgba(233, 19, 21, 0.06); padding: 0.125rem 0.375rem; border-radius: 0.25rem;"
                      >
                        {libp2p.peerId.toString().slice(0, 8)}...{libp2p.peerId
                          .toString()
                          .slice(-4)}
                      </code>
                      <button
                        data-testid="storacha-copy-peer-info"
                        onclick={handleCopyPeerInfo}
                        title="Copy your libp2p peer id"
                        style="display: flex; align-items: center; justify-content: center; height: 1.25rem; width: 1.25rem; border-radius: 0.25rem; border: none; background: transparent; cursor: pointer; color: #E91315; padding: 0; transition: all 150ms;"
                      >
                        <svg
                          style="height: 0.7rem; width: 0.7rem;"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                      </button>
                    {/if}
                  </div>
                </div>
                {#if ipnsNameString}
                  <div
                    style="font-size: 0.7rem; color: #6b7280; font-family: 'DM Mono', monospace; margin-top: 0.25rem;"
                  >
                    IPNS: {ipnsNameString.slice(0, 20)}...
                  </div>
                {/if}
              </div>

              {@render linkedDevicesPanel()}
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      <!-- Logged In Section -->
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <!-- Account Info -->
        <div
          style="display: flex; align-items: center; justify-content: space-between; border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #BDE0FF, #FFE4AE); padding: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
        >
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div
              style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
            >
              <CheckCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
            </div>
            <div>
              <div
                style="font-size: 0.875rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif;"
              >
                Connected to Storacha
              </div>
              {#if currentSpace}
                <div style="font-size: 0.75rem; color: #0176CE; font-family: 'DM Mono', monospace;">
                  Space: {formatSpaceName(currentSpace)}
                </div>
              {/if}
            </div>
          </div>

          <button
            class="storacha-btn-icon"
            onclick={handleLogout}
            style="display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.75rem; font-size: 0.875rem; color: #E91315; transition: color 150ms, background-color 150ms; border: none; background: transparent; cursor: pointer; font-family: 'DM Sans', sans-serif;"
          >
            <LogOut style="height: 0.75rem; width: 0.75rem;" />
            <span>Logout</span>
          </button>
        </div>

        <!-- Tab Navigation — P2P Passkeys first -->
        <div
          style="border-radius: 0.5rem; background: rgba(233, 19, 21, 0.06); padding: 0.25rem; display: flex; gap: 0.25rem;"
        >
          <button
            data-testid="storacha-tab-passkeys"
            onclick={() => handleTabSwitch('passkeys')}
            style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab ===
            'passkeys'
              ? 'linear-gradient(135deg, #E91315, #FFC83F)'
              : 'transparent'}; color: {activeTab === 'passkeys'
              ? '#fff'
              : '#6B7280'}; box-shadow: {activeTab === 'passkeys'
              ? '0 2px 8px rgba(233, 19, 21, 0.3)'
              : 'none'};"
          >
            P2P Passkeys
          </button>
          <button
            data-testid="storacha-tab-storacha"
            onclick={() => handleTabSwitch('storacha')}
            style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab ===
            'storacha'
              ? 'linear-gradient(135deg, #E91315, #FFC83F)'
              : 'transparent'}; color: {activeTab === 'storacha'
              ? '#fff'
              : '#6B7280'}; box-shadow: {activeTab === 'storacha'
              ? '0 2px 8px rgba(233, 19, 21, 0.3)'
              : 'none'};"
          >
            Storacha
          </button>
        </div>

        {#if activeTab === 'storacha'}
          <!-- Action Buttons -->
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <button
              class="storacha-btn-backup"
              onclick={handleBackup}
              disabled={isLoading || (!registryDb && entryCount === 0)}
              style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #FFC83F; padding: 0.5rem 1rem; font-weight: 700; color: #111827; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; opacity: {isLoading ||
              (!registryDb && entryCount === 0)
                ? '0.5'
                : '1'}; box-sizing: border-box;"
            >
              <Upload style="height: 1rem; width: 1rem;" />
              <span>Backup to Storacha</span>
            </button>

            <button
              class="storacha-btn-restore"
              onclick={restoreFromSpaceFallback}
              disabled={isLoading || !isInitialized}
              style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #0176CE; padding: 0.5rem 1rem; font-weight: 700; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; opacity: {isLoading ||
              !isInitialized
                ? '0.5'
                : '1'}; box-sizing: border-box;"
              title="Restore database from Storacha backup"
            >
              <Download style="height: 1rem; width: 1rem;" />
              <span>Restore from Storacha</span>
            </button>
          </div>

          <!-- Space Usage Information -->
          <div
            style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
          >
            <div
              style="margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;"
            >
              <h4
                style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; margin: 0;"
              >
                <svg
                  style="height: 1rem; width: 1rem;"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
                <span>Storage Analytics</span>
              </h4>
              <div style="display: flex; align-items: center; gap: 0.25rem;">
                <button
                  class="storacha-btn-icon"
                  onclick={loadSpaceUsage}
                  disabled={isLoading}
                  style="border-radius: 0.375rem; padding: 0.5rem; color: #E91315; transition: all 300ms; border: none; background: transparent; cursor: pointer; opacity: {isLoading
                    ? '0.5'
                    : '1'};"
                  title="Refresh space usage"
                  aria-label="Refresh space usage"
                >
                  <svg
                    style="height: 1rem; width: 1rem;"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
                {#if spaceUsage && spaceUsage.totalFiles <= 50 && !spaceUsage.analyzed}
                  <button
                    class="storacha-btn-icon"
                    onclick={async () => {
                      spaceUsage = await getSpaceUsage(client, true);
                    }}
                    disabled={isLoading}
                    style="border-radius: 0.375rem; padding: 0.5rem; color: #0176CE; transition: all 300ms; border: none; background: transparent; cursor: pointer; opacity: {isLoading
                      ? '0.5'
                      : '1'};"
                    title="Analyze file types"
                    aria-label="Analyze file types"
                  >
                    <svg
                      style="height: 1rem; width: 1rem;"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </button>
                {/if}
              </div>
            </div>

            {#if spaceUsage}
              <div
                style="margin-bottom: 1rem; border-radius: 0.25rem; border: 1px solid #E91315; background: linear-gradient(to right, #EFE3F3, #ffffff); padding: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);"
              >
                <div
                  style="display: flex; align-items: center; justify-content: space-between; font-size: 0.875rem;"
                >
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <div
                      style="display: flex; height: 1.5rem; width: 1.5rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
                    >
                      <span
                        style="font-size: 0.75rem; font-weight: 700; color: #ffffff; font-family: 'DM Mono', monospace;"
                        >{spaceUsage.totalFiles}</span
                      >
                    </div>
                    <span
                      style="font-weight: 500; color: #1f2937; font-family: 'DM Sans', sans-serif;"
                    >
                      file{spaceUsage.totalFiles !== 1 ? 's' : ''} stored
                    </span>
                  </div>
                  {#if spaceUsage.lastUploadDate}
                    <div
                      style="color: #0176CE; font-family: 'DM Mono', monospace; font-size: 0.75rem;"
                    >
                      Last upload: {formatRelativeTime(spaceUsage.lastUploadDate)}
                    </div>
                  {/if}
                </div>

                {#if spaceUsage.totalFiles > 0}
                  <div
                    style="margin-top: 0.5rem; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; font-size: 0.75rem;"
                  >
                    {#if spaceUsage.backupFiles > 0}
                      <div style="display: flex; align-items: center; gap: 0.25rem;">
                        <div
                          style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #FFC83F;"
                        ></div>
                        <span style="color: #374151; font-family: 'DM Sans', sans-serif;">
                          {spaceUsage.backupFiles} backup{spaceUsage.backupFiles !== 1 ? 's' : ''}
                        </span>
                      </div>
                    {/if}
                    {#if spaceUsage.blockFiles > 0}
                      <div style="display: flex; align-items: center; gap: 0.25rem;">
                        <div
                          style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #0176CE;"
                        ></div>
                        <span style="color: #374151; font-family: 'DM Sans', sans-serif;">
                          {spaceUsage.blockFiles} data block{spaceUsage.blockFiles !== 1 ? 's' : ''}
                        </span>
                      </div>
                    {/if}
                    {#if spaceUsage.otherFiles > 0}
                      <div style="display: flex; align-items: center; gap: 0.25rem;">
                        <div
                          style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #E91315;"
                        ></div>
                        <span style="color: #374151; font-family: 'DM Sans', sans-serif;">
                          {spaceUsage.otherFiles} other
                        </span>
                      </div>
                    {/if}
                  </div>

                  <div
                    style="margin-top: 0.5rem; font-size: 0.75rem; color: #4b5563; font-family: 'DM Sans', sans-serif;"
                  >
                    {#if spaceUsage.oldestUploadDate && spaceUsage.oldestUploadDate !== spaceUsage.lastUploadDate}
                      <div style="color: #0176CE; font-family: 'DM Mono', monospace;">
                        Oldest upload: {formatRelativeTime(spaceUsage.oldestUploadDate)}
                      </div>
                    {/if}
                    <em style="color: #6b7280;">Note: Each backup creates many data blocks</em>
                  </div>
                {/if}
              </div>
            {:else if spaceUsage === null && isLoggedIn}
              <div
                style="margin-bottom: 1rem; border-radius: 0.25rem; border: 1px solid #E91315; background: linear-gradient(to right, #EFE3F3, #FFE4AE); padding: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);"
              >
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div
                    style="display: flex; height: 1.25rem; width: 1.25rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; flex-shrink: 0;"
                  >
                    <svg
                      style="height: 0.75rem; width: 0.75rem; color: #ffffff;"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <div
                    style="font-size: 0.875rem; font-weight: 500; color: #E91315; font-family: 'DM Sans', sans-serif;"
                  >
                    Space usage information unavailable
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        {#if activeTab === 'passkeys'}
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <!-- Connection Status + Copy -->
            <div
              style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #ffffff, #FFE4AE); padding: 0.625rem 0.75rem;"
            >
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div style="display: flex; align-items: center; gap: 0.25rem;">
                    <div
                      style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background: {p2pLedDotBg}; box-shadow: {p2pLedShadow}; animation: {p2pLedPulse
                        ? 'pulse 2s infinite'
                        : 'none'};"
                    ></div>
                    {#if libp2p}
                      <span
                        data-testid="storacha-p2p-remote-peer-count"
                        title="Connected libp2p peers"
                        style="font-size: 0.65rem; font-weight: 700; font-family: 'DM Mono', monospace; color: {p2pLedTextColor}; line-height: 1; min-width: 0.65rem; text-align: center;"
                        >{p2pRemotePeerCount}</span
                      >
                    {/if}
                  </div>
                  <span
                    style="font-size: 0.75rem; font-weight: 600; color: {p2pLedTextColor}; font-family: 'Epilogue', sans-serif;"
                  >
                    {p2pConnectionLabel}
                  </span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.375rem;">
                  {#if libp2p}
                    <code
                      style="font-size: 0.6rem; color: #E91315; font-family: 'DM Mono', monospace; background: rgba(233, 19, 21, 0.06); padding: 0.125rem 0.375rem; border-radius: 0.25rem;"
                    >
                      {libp2p.peerId.toString().slice(0, 8)}...{libp2p.peerId.toString().slice(-4)}
                    </code>
                    <button
                      data-testid="storacha-copy-peer-info"
                      onclick={handleCopyPeerInfo}
                      title="Copy your libp2p peer id"
                      style="display: flex; align-items: center; justify-content: center; height: 1.25rem; width: 1.25rem; border-radius: 0.25rem; border: none; background: transparent; cursor: pointer; color: #E91315; padding: 0; transition: all 150ms;"
                    >
                      <svg
                        style="height: 0.7rem; width: 0.7rem;"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                    </button>
                  {/if}
                </div>
              </div>
              {#if ipnsNameString}
                <div
                  style="font-size: 0.7rem; color: #6b7280; font-family: 'DM Mono', monospace; margin-top: 0.25rem;"
                >
                  IPNS: {ipnsNameString.slice(0, 20)}...
                </div>
              {/if}
            </div>

            {#if !libp2p}
              <div
                style="border-radius: 0.375rem; border: 1px dashed #E91315; background: rgba(233, 19, 21, 0.03); padding: 1.25rem; text-align: center;"
              >
                <div
                  style="font-size: 0.8rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; margin-bottom: 0.25rem;"
                >
                  P2P Networking Not Available
                </div>
                <div
                  style="font-size: 0.75rem; color: #6B7280; font-family: 'DM Sans', sans-serif; line-height: 1.4;"
                >
                  Provide a libp2p instance to enable device linking and peer-to-peer sync.
                </div>
              </div>
            {:else}
              <!-- Link Device -->
              <div
                style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 0.75rem;"
              >
                <div
                  style="font-size: 0.65rem; font-weight: 700; color: #E91315; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'DM Sans', sans-serif; margin-bottom: 0.5rem;"
                >
                  Link Another Device
                </div>
                {#if !linkDeviceReady}
                  <div
                    style="margin-bottom: 0.5rem; font-size: 0.65rem; color: #b45309; font-family: 'DM Sans', sans-serif; line-height: 1.35; border-radius: 0.375rem; background: rgba(254, 243, 199, 0.9); padding: 0.45rem 0.55rem; border: 1px solid #fbbf24;"
                  >
                    Registry / MultiDeviceManager not ready — button stays disabled until linking
                    can run.
                  </div>
                {/if}
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  <input
                    type="text"
                    data-testid="storacha-link-peer-input"
                    class="storacha-link-peer-id-input"
                    bind:value={linkInput}
                    placeholder="Other device’s peer id (12D3KooW…)"
                    autocomplete="off"
                    spellcheck="false"
                    style="width: 100%; border-radius: 0.375rem; border: 1px solid #E91315; background: #ffffff; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #111827; font-family: 'DM Mono', monospace; outline: none; box-sizing: border-box;"
                  />
                  <button
                    data-testid="storacha-link-device-submit"
                    data-mdm-ready={linkDeviceReady ? 'true' : 'false'}
                    type="button"
                    onclick={handleLinkDevice}
                    disabled={linkDeviceDisabled}
                    title={!linkDeviceReady
                      ? 'Waiting for device registry / MultiDeviceManager'
                      : 'Link using the other device’s peer id'}
                    style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.5rem 1rem; color: #ffffff; border: none; cursor: {linkDeviceDisabled
                      ? 'not-allowed'
                      : 'pointer'}; font-family: 'Epilogue', sans-serif; font-weight: 700; font-size: 0.8rem; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); opacity: {linkDeviceDisabled
                      ? '0.5'
                      : '1'}; box-sizing: border-box;"
                  >
                    {#if isLinking}
                      <Loader2
                        style="height: 0.875rem; width: 0.875rem; animation: spin 1s linear infinite;"
                      />
                      Linking...
                    {:else}
                      <svg
                        style="height: 0.875rem; width: 0.875rem;"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                        />
                      </svg>
                      Link Device
                    {/if}
                  </button>
                </div>
                {#if linkError}
                  <div
                    data-testid="storacha-link-error"
                    style="margin-top: 0.5rem; font-size: 0.75rem; color: #b91c1c; font-family: 'DM Sans', sans-serif;"
                  >
                    {linkError}
                  </div>
                {/if}
              </div>
            {/if}

            {@render linkedDevicesPanel()}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .storacha-panel::-webkit-scrollbar {
    width: 4px;
  }
  .storacha-panel::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.1);
    border-radius: 2px;
  }
  .storacha-panel::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 2px;
  }
  .storacha-panel::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.4);
  }

  .storacha-btn-primary:hover:not(:disabled) {
    background-color: #b91c1c;
  }
  .storacha-btn-backup:hover:not(:disabled) {
    background-color: #eab308;
  }
  .storacha-btn-restore:hover:not(:disabled) {
    background-color: #1d4ed8;
  }
  .storacha-btn-icon:hover:not(:disabled) {
    background-color: rgba(233, 19, 21, 0.1);
  }
  .storacha-toggle:hover {
    background-color: rgba(233, 19, 21, 0.08);
  }
  .storacha-textarea:focus {
    border-color: transparent;
    box-shadow: 0 0 0 2px #e91315;
  }
</style>
