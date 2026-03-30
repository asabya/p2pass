/**
 * Storacha auth via UCAN delegation (replaces legacy key+proof flows).
 *
 * Delegation persistence prefers the OrbitDB registry DB when available; otherwise uses `localStorage`.
 *
 * @module ucan/storacha-auth
 */

import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import {
  storeDelegationEntry,
  listDelegations,
  removeDelegation as removeRegistryDelegation,
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

    const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    const result = await Delegation.extract(bytes);

    if (result.ok) {
      console.log('[storacha] Delegation parsed via @ucanto/core/delegation.extract()');
      return result.ok;
    }

    throw new Error(result.error?.message || 'Delegation extraction failed');
  } catch (err) {
    throw new Error(`Failed to parse delegation: ${err.message}`, { cause: err });
  }
}

/**
 * Store a raw delegation string.
 * Uses registry DB if provided, otherwise localStorage fallback.
 *
 * @param {string} delegationBase64
 * @param {Object} [registryDb] - OrbitDB registry database
 * @param {string} [spaceDid] - Storacha space DID (for registry metadata)
 * @param {string} [storedByDid] - device DID that imported the delegation (per-device counts in UI)
 */
export async function storeDelegation(delegationBase64, registryDb, spaceDid, storedByDid) {
  if (registryDb) {
    try {
      await storeDelegationEntry(registryDb, delegationBase64, spaceDid, undefined, storedByDid);
      console.log('[storacha] Delegation stored in registry DB');
      return;
    } catch (err) {
      console.warn('[storacha] Registry write failed, falling back to localStorage:', err.message);
    }
  }
  localStorage.setItem(STORAGE_KEY_DELEGATION, delegationBase64);
  console.log('[storacha] Delegation stored in localStorage');
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
      const sorted = delegations.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      console.log('[storacha] Loaded delegation from registry DB');
      return sorted[0].delegation;
    }
    // Registry exists but has no delegations — fall through to localStorage
  }

  const local = localStorage.getItem(STORAGE_KEY_DELEGATION);
  if (local) console.log('[storacha] Loaded delegation from localStorage');
  return local;
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

/** Max characters for native `title` tooltips (browser-dependent display). */
const DELEGATION_TOOLTIP_MAX = 1200;

/**
 * @param {string} s
 * @param {number} max
 */
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/**
 * @param {unknown} p - UCANTO principal or string
 */
function principalDid(p) {
  if (p == null) return '—';
  if (typeof p === 'string') return p;
  if (typeof p === 'object' && p !== null && 'did' in p && typeof p.did === 'function') {
    try {
      return /** @type {{ did: () => string }} */ (p).did();
    } catch {
      return String(p);
    }
  }
  return String(p);
}

/**
 * @param {unknown} exp - UCAN expiration (seconds or ms since epoch)
 */
function formatUcanExpiration(exp) {
  if (exp == null) return null;
  const n = typeof exp === 'bigint' ? Number(exp) : Number(exp);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toUTCString();
  } catch {
    return String(exp);
  }
}

/**
 * @param {any} d - Parsed delegation from {@link parseDelegation}
 * @returns {string}
 */
function summarizeParsedDelegationForTooltip(d) {
  const lines = [];
  lines.push(`Issuer: ${truncateMiddle(principalDid(d?.issuer), 64)}`);
  lines.push(`Audience: ${truncateMiddle(principalDid(d?.audience), 64)}`);
  const expStr = formatUcanExpiration(d?.expiration);
  if (expStr) lines.push(`Expires: ${expStr}`);
  const nbStr = formatUcanExpiration(d?.notBefore);
  if (nbStr) lines.push(`Not before: ${nbStr}`);
  const caps = d?.capabilities;
  if (Array.isArray(caps) && caps.length > 0) {
    const shown = caps.slice(0, 6).map((c) => {
      const can = c?.can ?? '?';
      const w = c?.with != null ? String(c.with) : '—';
      return `${can} → ${truncateMiddle(w, 48)}`;
    });
    let capBlock = shown.join('\n');
    if (caps.length > 6) capBlock += `\n… +${caps.length - 6} more`;
    lines.push(`Capabilities:\n${capBlock}`);
  }
  const facts = d?.facts;
  if (Array.isArray(facts) && facts.length > 0) {
    lines.push(`Facts: ${facts.length} attached`);
  }
  try {
    if (d?.cid != null) lines.push(`Root CID: ${truncateMiddle(String(d.cid), 72)}`);
  } catch {
    /* ignore */
  }
  return lines.join('\n');
}

/**
 * Multi-line text suitable for a native HTML `title` on the linked-device UCAN badge.
 * Parses each stored delegation via {@link parseDelegation}.
 *
 * @param {Array<{ delegation?: string, space_did?: string, label?: string }>} entries
 * @returns {Promise<string>}
 */
export async function formatDelegationsTooltipSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'No UCAN delegations';
  }
  const blocks = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const raw = e?.delegation;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let head = entries.length > 1 ? `Delegation ${i + 1} of ${entries.length}` : 'UCAN delegation';
    if (e.space_did) head += ` · Space ${truncateMiddle(e.space_did, 40)}`;
    if (e.label && e.label !== 'default') head += ` · ${e.label}`;
    try {
      const parsed = await parseDelegation(raw);
      blocks.push(`${head}\n${summarizeParsedDelegationForTooltip(parsed)}`);
    } catch (err) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String(/** @type {{ message: string }} */ (err).message)
          : String(err);
      blocks.push(`${head}\n(parse failed: ${truncateMiddle(msg, 100)})`);
    }
  }
  if (blocks.length === 0) return 'No valid delegation payloads';
  const joined = blocks.join('\n\n────────\n\n');
  return joined.length > DELEGATION_TOOLTIP_MAX
    ? truncateMiddle(joined, DELEGATION_TOOLTIP_MAX)
    : joined;
}
