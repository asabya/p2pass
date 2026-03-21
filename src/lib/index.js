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

// Legacy storacha backup utilities (will be replaced)
export {
	listSpaces,
	getSpaceUsage,
	listStorachaFiles
} from './ui/storacha-backup.js';
