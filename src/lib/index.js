// @le-space/p2pass — public API
export const VERSION = '0.3.1';

// Explicit default bindings (not `export { default as X } from`) — avoids star-export / default resolution errors in Vite.
import StorachaIntegration from './ui/StorachaIntegration.svelte';
import StorachaFab from './ui/StorachaFab.svelte';
export { StorachaIntegration, StorachaFab };

// Identity
export { IdentityService, hasLocalPasskeyHint } from './identity/identity-service.js';
export { detectSigningMode, getStoredSigningMode } from './identity/mode-detector.js';
export {
  SIGNING_PREFERENCE_STORAGE_KEY,
  SIGNING_PREFERENCE_LIST,
  isSigningPreference,
  readSigningPreferenceFromStorage,
  writeSigningPreferenceToStorage,
  resolveSigningPreference,
} from './identity/signing-preference.js';

// UCAN / Storacha auth
export {
  createStorachaClient,
  parseDelegation,
  storeDelegation,
  loadStoredDelegation,
  clearStoredDelegation,
  formatDelegationsTooltipSummary,
} from './ucan/storacha-auth.js';

// Registry (multi-device + credential storage)
export { MultiDeviceManager } from './registry/manager.js';
export {
  openDeviceRegistry,
  registerDevice,
  listDevices,
  getDeviceByCredentialId,
  getDeviceByDID,
  grantDeviceWriteAccess,
  revokeDeviceAccess,
  removeDeviceEntry,
  delegationCountForDevice,
  delegationsEntriesForDevice,
  hashCredentialId,
  coseToJwk,
  storeDelegationEntry,
  listDelegations,
  getDelegation,
  removeDelegation,
  storeArchiveEntry,
  getArchiveEntry,
  storeKeypairEntry,
  getKeypairEntry,
  listKeypairs,
} from './registry/device-registry.js';
export {
  LINK_DEVICE_PROTOCOL,
  registerLinkDeviceHandler,
  unregisterLinkDeviceHandler,
  sendPairingRequest,
  detectDeviceLabel,
  sortPairingMultiaddrs,
  filterPairingDialMultiaddrs,
  pairingFlow,
  PAIRING_HINT_ADDR_CAP,
} from './registry/pairing-protocol.js';

// P2P stack setup
export {
  setupP2PStack,
  createLibp2pInstance,
  createHeliaInstance,
  cleanupP2PStack,
} from './p2p/setup.js';

// Legacy storacha backup utilities (will be replaced)
export { listSpaces, getSpaceUsage, listStorachaFiles } from './ui/storacha-backup.js';

// Recovery (IPNS manifest)
export {
  deriveIPNSKeyPair,
  computeDeterministicPrfSalt,
  recoverPrfSeed,
} from './recovery/ipns-key.js';

export {
  createManifest,
  publishManifest,
  resolveManifest,
  resolveManifestByName,
  uploadArchiveToIPFS,
  fetchArchiveFromIPFS,
} from './recovery/manifest.js';

// Backup (registry)
export { backupRegistryDb, restoreRegistryDb } from './backup/registry-backup.js';
