/**
 * Storacha auth via UCAN delegation.
 * Replaces the old key+proof credential flow.
 */

import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';

const STORAGE_KEY_DELEGATION = 'storacha_ucan_delegation';

/**
 * Create a Storacha client using a UCAN principal and delegation proof.
 *
 * @param {any} principal - UCAN-compatible signer (from IdentityService.getPrincipal())
 * @param {any} delegation - Parsed delegation object (from parseDelegation())
 * @returns {Promise<any>} Storacha Client instance with space set
 */
export async function createStorachaClient(principal, delegation) {
	console.log('Creating Storacha client with UCAN principal...');

	const store = new StoreMemory();
	const client = await Client.create({ principal, store });

	// Add space from delegation
	const space = await client.addSpace(delegation);
	await client.setCurrentSpace(space.did());

	console.log(`Storacha client ready. Space: ${space.did()}`);
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
		console.log('Delegation parsed via @storacha/client/proof');
		return delegation;
	} catch (err) {
		console.warn('Proof.parse() failed, trying ucanto extraction...', err.message);
	}

	// Try @ucanto/core/delegation.extract() with base64 decoding
	try {
		const Delegation = await import('@ucanto/core/delegation');

		// Handle multibase prefixes
		let base64Data = trimmed;
		if (base64Data.startsWith('u')) {
			// base64url → standard base64
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
			console.log('Delegation parsed via @ucanto/core/delegation.extract()');
			return result.ok;
		}

		throw new Error(result.error?.message || 'Delegation extraction failed');
	} catch (err) {
		throw new Error(`Failed to parse delegation: ${err.message}`);
	}
}

/**
 * Store a raw delegation string in localStorage.
 * @param {string} delegationBase64
 */
export function storeDelegation(delegationBase64) {
	localStorage.setItem(STORAGE_KEY_DELEGATION, delegationBase64);
}

/**
 * Load a stored delegation string from localStorage.
 * @returns {string|null}
 */
export function loadStoredDelegation() {
	return localStorage.getItem(STORAGE_KEY_DELEGATION);
}

/**
 * Clear stored delegation.
 */
export function clearStoredDelegation() {
	localStorage.removeItem(STORAGE_KEY_DELEGATION);
}
