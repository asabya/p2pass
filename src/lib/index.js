// p2p-passkeys — public API
export const VERSION = '0.1.0';

// UI components
export { default as StorachaIntegration } from './ui/StorachaIntegration.svelte';
export { default as StorachaFab } from './ui/StorachaFab.svelte';

// Identity
export { IdentityService } from './identity/identity-service.js';
export { detectSigningMode, getStoredSigningMode } from './identity/mode-detector.js';

// UCAN / Storacha auth
export {
	createStorachaClient,
	parseDelegation,
	storeDelegation,
	loadStoredDelegation,
	clearStoredDelegation
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
	listKeypairs
} from './registry/device-registry.js';
export {
	LINK_DEVICE_PROTOCOL,
	registerLinkDeviceHandler,
	unregisterLinkDeviceHandler,
	sendPairingRequest,
	detectDeviceLabel
} from './registry/pairing-protocol.js';

// P2P stack setup
export {
	setupP2PStack,
	createLibp2pInstance,
	createHeliaInstance,
	cleanupP2PStack
} from './p2p/setup.js';

// Legacy storacha backup utilities (will be replaced)
export {
	listSpaces,
	getSpaceUsage,
	listStorachaFiles
} from './ui/storacha-backup.js';

// Recovery (IPNS manifest)
export {
	deriveIPNSKeyPair,
	computeDeterministicPrfSalt,
	recoverPrfSeed
} from './recovery/ipns-key.js';

export {
	createManifest,
	publishManifest,
	resolveManifest,
	resolveManifestByName,
	uploadArchiveToIPFS,
	fetchArchiveFromIPFS
} from './recovery/manifest.js';

// Backup (registry)
export {
	backupRegistryDb,
	restoreRegistryDb
} from './backup/registry-backup.js';
