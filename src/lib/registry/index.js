/**
 * Registry subpackage — multi-device linking, credential storage, and UCAN delegation sync.
 *
 * Re-exports device registry helpers, pairing protocol, and `MultiDeviceManager`.
 *
 * @module registry
 */

// Device registry + extended storage (delegations, archives, keypairs)
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
  // Delegation storage
  storeDelegationEntry,
  listDelegations,
  getDelegation,
  removeDelegation,
  // Archive storage
  storeArchiveEntry,
  getArchiveEntry,
  // Keypair metadata storage
  storeKeypairEntry,
  getKeypairEntry,
  listKeypairs,
} from './device-registry.js';

// Pairing protocol
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
} from './pairing-protocol.js';

// Manager
export { MultiDeviceManager } from './manager.js';
