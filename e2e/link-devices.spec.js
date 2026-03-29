import { test, expect } from '@playwright/test';
import {
  addVirtualWebAuthn,
  createPasskeyAndOpenP2PTab,
  pairBobWithAlice,
} from './helpers.js';

const signingMode = /** @type {'hardware-ed25519' | 'hardware-p256' | 'worker'} */ (
  process.env.E2E_SIGNING_MODE || 'worker'
);

test.describe(`P2P link devices (local relay) — ${signingMode}`, () => {
  test('Alice and Bob passkeys, paste peer info JSON (e2e), approve, both see linked devices', async ({
    browser,
  }, testInfo) => {
    // Manual `browser.newContext()` does not inherit `use.baseURL` from playwright.config.js.
    // Without this, `page.goto('/')` is invalid and the app (and WebAuthn) never load reliably.
    const baseURL = testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';

    const alice = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const bob = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    const alicePage = await alice.newPage();
    const bobPage = await bob.newPage();

    await addVirtualWebAuthn(alice, alicePage, { signingPreference: signingMode });
    await addVirtualWebAuthn(bob, bobPage, { signingPreference: signingMode });

    await createPasskeyAndOpenP2PTab(alicePage, { signingPreference: signingMode });
    await createPasskeyAndOpenP2PTab(bobPage, { signingPreference: signingMode });

    await pairBobWithAlice(alicePage, bobPage);

    const row = alicePage.locator('[data-testid="storacha-linked-device-row"]');
    await expect(row).toHaveCount(2, { timeout: 120_000 });
    await expect(bobPage.locator('[data-testid="storacha-linked-device-row"]')).toHaveCount(2, {
      timeout: 120_000,
    });

    await alice.close();
    await bob.close();
  });
});
