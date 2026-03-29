import { expect } from '@playwright/test';
import { SIGNING_PREFERENCE_STORAGE_KEY } from '../src/lib/identity/signing-preference.js';

/**
 * @param {{ signingPreference?: string }} [options]
 * @returns {'hardware-ed25519' | 'hardware-p256' | 'worker'}
 */
function resolveE2eSigningPreference(options = {}) {
  const raw =
    options.signingPreference ||
    (typeof process !== 'undefined' && process.env.E2E_SIGNING_MODE) ||
    'worker';
  if (raw === 'hardware-ed25519' || raw === 'hardware-p256' || raw === 'worker') {
    return raw;
  }
  return 'worker';
}

/**
 * Attach a virtual authenticator on the app origin. Navigates to `/` after seeding signing preference.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Page} page
 * @param {{ signingPreference?: 'hardware-ed25519' | 'hardware-p256' | 'worker' }} [options]
 */
export async function addVirtualWebAuthn(context, page, options = {}) {
  const pref = resolveE2eSigningPreference(options);

  await page.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    [SIGNING_PREFERENCE_STORAGE_KEY, pref]
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
}

/**
 * Test id for the signing-mode radio matching {@link resolveE2eSigningPreference}.
 * @param {'hardware-ed25519' | 'hardware-p256' | 'worker'} mode
 */
function signingPreferenceRadioTestId(mode) {
  if (mode === 'hardware-ed25519') return 'storacha-signing-pref-hardware-ed25519';
  if (mode === 'hardware-p256') return 'storacha-signing-pref-hardware-p256';
  return 'storacha-signing-pref-worker';
}

/**
 * Open panel, choose signing mode, authenticate. Call after {@link addVirtualWebAuthn}.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ signingPreference?: string }} [options] - defaults from `E2E_SIGNING_MODE` / `worker`
 */
export async function createPasskeyAndOpenP2PTab(page, options = {}) {
  const mode = resolveE2eSigningPreference(options);

  await expect(page).toHaveURL(/localhost/);
  await page.getByTestId('storacha-fab-toggle').click();
  await expect(page.getByTestId('storacha-panel')).toBeVisible();

  await expect(page.getByTestId('storacha-signing-preference-group')).toBeVisible();
  await page.getByTestId(signingPreferenceRadioTestId(mode)).click();
  await expect(page.getByTestId(signingPreferenceRadioTestId(mode))).toBeChecked();

  await page.getByTestId('storacha-passkey-primary').click();

  // Must not match login copy only — wait for post-auth shell (Your DID / badges).
  await expect(page.getByTestId('storacha-post-auth')).toBeVisible({ timeout: 120_000 });

  await expect(page.getByTestId('storacha-copy-peer-info').first()).toBeVisible({
    timeout: 120_000,
  });

  // Link button stays disabled while the peer-id field is empty. Wait for MultiDeviceManager — paste peer id before clicking.
  await expect(page.getByTestId('storacha-link-device-submit').first()).toHaveAttribute(
    'data-mdm-ready',
    'true',
    { timeout: 120_000 }
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function copyPeerInfoFromClipboard(page) {
  await page.getByTestId('storacha-copy-peer-info').first().click();
  let text = '';
  await expect
    .poll(async () => {
      text = await page.evaluate(() => navigator.clipboard.readText());
      return /^12D3KooW[a-zA-Z0-9]+$/.test(text.trim()) && text.trim().length >= 50;
    })
    .toBe(true);
  return text.trim();
}

/**
 * Full `{ peerId, multiaddrs }` JSON for reliable pairing in e2e. Peer-id-only paste fails when
 * two isolated browser contexts have not yet populated each other’s peer store (see example
 * `window.__p2passE2E` in App.svelte).
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function getLinkPayloadJsonForE2e(page) {
  let payload = '';
  await expect
    .poll(
      async () => {
        payload = await page.evaluate(() => {
          const api = globalThis.__p2passE2E;
          if (!api?.getPeerInfo) return '';
          const info = api.getPeerInfo();
          if (!info?.peerId || !Array.isArray(info.multiaddrs) || info.multiaddrs.length === 0) {
            return '';
          }
          return JSON.stringify(info);
        });
        return payload.length > 20;
      },
      { timeout: 120_000 }
    )
    .toBe(true);
  return payload;
}
