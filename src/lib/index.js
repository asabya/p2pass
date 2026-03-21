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

// Legacy storacha backup utilities (will be replaced)
export {
	listSpaces,
	getSpaceUsage,
	listStorachaFiles
} from './ui/storacha-backup.js';
