/**
 * Storacha auth via UCAN delegation.
 * Replaces the old key+proof credential flow.
 *
 * Delegation storage prefers OrbitDB registry DB when available,
 * falls back to localStorage.
 */

import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import {
	storeDelegationEntry,
	listDelegations,
	removeDelegation as removeRegistryDelegation
} from '../registry/device-registry.js';

const STORAGE_KEY_DELEGATION = 'storacha_ucan_delegation';

/**
 * Create a Storacha client using a UCAN principal and delegation proof.
 *
 * @param {any} principal - UCAN-compatible signer (from IdentityService.getPrincipal())
 * @param {any} delegation - Parsed delegation object (from parseDelegation())
 * @returns {Promise<any>} Storacha Client instance with space set
 */
export async function createStorachaClient(principal, delegation) {
	console.log('[storacha] Creating client with UCAN principal...');

	const store = new StoreMemory();
	const client = await Client.create({ principal, store });

	// Add space from delegation
	const space = await client.addSpace(delegation);
	await client.setCurrentSpace(space.did());

	console.log(`[storacha] Client ready. Space: ${space.did()}`);
	return client;
}

/**
 * Parse a delegation proof string. Supports multiple formats:
 * - Multibase base64url (u prefix)
 * - Multibase base64 (m prefix)
 * - Raw base64
 * - CAR bytes
 *
 * @param {string} proofString - The delegation proof as a string
 * @returns {Promise<any>} Parsed delegation object
 */
export async function parseDelegation(proofString) {
	const trimmed = proofString.trim();

	// Try @storacha/client/proof.parse() first (handles most formats)
	try {
		const Proof = await import('@storacha/client/proof');
		const delegation = await Proof.parse(trimmed);
		console.log('[storacha] Delegation parsed via @storacha/client/proof');
		return delegation;
	} catch (err) {
		console.warn('[storacha] Proof.parse() failed, trying ucanto extraction...', err.message);
	}

	// Try @ucanto/core/delegation.extract() with base64 decoding
	try {
		const Delegation = await import('@ucanto/core/delegation');

		// Handle multibase prefixes
		let base64Data = trimmed;
		if (base64Data.startsWith('u')) {
			base64Data = base64Data.slice(1).replace(/-/g, '+').replace(/_/g, '/');
		} else if (base64Data.startsWith('m')) {
			base64Data = base64Data.slice(1);
		}

		// Pad if needed
		while (base64Data.length % 4 !== 0) {
			base64Data += '=';
		}

		const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
		const result = await Delegation.extract(bytes);

		if (result.ok) {
			console.log('[storacha] Delegation parsed via @ucanto/core/delegation.extract()');
			return result.ok;
		}

		throw new Error(result.error?.message || 'Delegation extraction failed');
	} catch (err) {
		throw new Error(`Failed to parse delegation: ${err.message}`);
	}
}

/**
 * Store a raw delegation string.
 * Uses registry DB if provided, otherwise localStorage fallback.
 *
 * @param {string} delegationBase64
 * @param {Object} [registryDb] - OrbitDB registry database
 * @param {string} [spaceDid] - Storacha space DID (for registry metadata)
 */
export async function storeDelegation(delegationBase64, registryDb, spaceDid) {
	if (registryDb) {
		await storeDelegationEntry(registryDb, delegationBase64, spaceDid);
		console.log('[storacha] Delegation stored in registry DB');
	} else {
		localStorage.setItem(STORAGE_KEY_DELEGATION, delegationBase64);
		console.log('[storacha] Delegation stored in localStorage (no registry)');
	}
}

/**
 * Load a stored delegation string.
 * Reads from registry DB if provided, otherwise localStorage.
 *
 * @param {Object} [registryDb] - OrbitDB registry database
 * @returns {Promise<string|null>}
 */
export async function loadStoredDelegation(registryDb) {
	if (registryDb) {
		const delegations = await listDelegations(registryDb);
		if (delegations.length > 0) {
			// Return the most recent delegation
			const sorted = delegations.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
			console.log('[storacha] Loaded delegation from registry DB');
			return sorted[0].delegation;
		}
		return null;
	}

	return localStorage.getItem(STORAGE_KEY_DELEGATION);
}

/**
 * Clear stored delegation(s).
 * If registryDb is provided, removes all delegations from it.
 * Otherwise clears from localStorage.
 *
 * @param {Object} [registryDb] - OrbitDB registry database
 * @param {string} [delegationBase64] - specific delegation to remove (if omitted, removes all)
 */
export async function clearStoredDelegation(registryDb, delegationBase64) {
	if (registryDb) {
		if (delegationBase64) {
			await removeRegistryDelegation(registryDb, delegationBase64);
		} else {
			// Remove all delegations from registry
			const all = await listDelegations(registryDb);
			for (const entry of all) {
				if (entry.delegation) {
					await removeRegistryDelegation(registryDb, entry.delegation);
				}
			}
		}
		console.log('[storacha] Delegation(s) removed from registry DB');
	} else {
		localStorage.removeItem(STORAGE_KEY_DELEGATION);
	}
}
