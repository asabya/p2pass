import { test, expect } from '@playwright/test';
import {
  addVirtualWebAuthn,
  createPasskeyAndOpenP2PTab,
  getLinkPayloadJsonForE2e,
} from './helpers.js';

test.describe('P2P link devices (local relay)', () => {
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

    await addVirtualWebAuthn(alice, alicePage);
    await addVirtualWebAuthn(bob, bobPage);

    await createPasskeyAndOpenP2PTab(alicePage);
    await createPasskeyAndOpenP2PTab(bobPage);

    // Isolated contexts rarely have a working peer-id-only route; use full payload like manual JSON paste.
    const alicePayload = await getLinkPayloadJsonForE2e(alicePage);
    expect(alicePayload).toContain('"multiaddrs"');

    await bobPage.getByTestId('storacha-link-peer-input').first().fill(alicePayload);
    await bobPage.getByTestId('storacha-link-device-submit').first().click();

    await alicePage.bringToFront();
    await alicePage
      .getByTestId('storacha-pairing-prompt')
      .waitFor({ state: 'visible', timeout: 120_000 });
    await alicePage.getByTestId('storacha-pairing-approve').click({ timeout: 120_000 });

    const row = alicePage.locator('[data-testid="storacha-linked-device-row"]');
    await expect(row).toHaveCount(2, { timeout: 120_000 });
    await expect(bobPage.locator('[data-testid="storacha-linked-device-row"]')).toHaveCount(2, {
      timeout: 120_000,
    });

    await alice.close();
    await bob.close();
  });
});
