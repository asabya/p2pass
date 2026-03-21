/**
 * Registry — Multi-device linking, credential storage, and UCAN delegation sync.
 *
 * Re-exports device registry, pairing protocol, and manager.
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
} from './pairing-protocol.js';

// Manager
export { MultiDeviceManager } from './manager.js';
