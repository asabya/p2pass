import { expect } from '@playwright/test';

/**
 * Attach a virtual authenticator on the app origin. Must run after navigation to a
 * valid WebAuthn context (e.g. http://localhost), not on about:blank.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Page} page
 */
export async function addVirtualWebAuthn(context, page) {
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
 * Open Storacha, create passkey, open P2P tab, wait until linking is ready.
 * @param {import('@playwright/test').Page} page
 */
export async function createPasskeyAndOpenP2PTab(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/localhost/);
  await page.getByTestId('storacha-fab-toggle').click();
  await expect(page.getByTestId('storacha-panel')).toBeVisible();

  await page.getByTestId('storacha-passkey-primary').click();

  await expect(page.getByText(/Worker Ed25519|Hardware Ed25519|Hardware P-256/)).toBeVisible({
    timeout: 120_000,
  });

  await page.getByTestId('storacha-tab-passkeys').first().click();

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
 * `window.__p2pPasskeysE2E` in App.svelte).
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
          const api = globalThis.__p2pPasskeysE2E;
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
