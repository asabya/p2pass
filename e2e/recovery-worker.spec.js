import { test, expect } from '@playwright/test';
import {
  addVirtualWebAuthn,
  createPasskeyAndOpenP2PTab,
  recoverPasskeyFromPreAuth,
  expectLinkedDeviceRowCount,
  pairBobWithAlice,
  importStorachaDelegationForE2e,
  E2E_LOCAL_RECOVERY_CACHE_KEYS,
} from './helpers.js';

const WORKER = /** @type {const} */ ('worker');

/**
 * Requires the default Playwright webServer (`scripts/e2e-with-relay.mjs` + Vite). Do not use
 * `PW_REUSE_SERVER=1` unless that full stack is already running — otherwise libp2p has no relay and
 * device linking / pairing never appears.
 *
 * (a) Same setup as `link-devices.spec.js` (Alice + Bob, pair). Only **Alice’s tab** reloads; then
 * **Recover Passkey** exercises the local OrbitDB path (`OWNER_DID` + registry address still in
 * `localStorage`). Bob is not reloaded.
 *
 * (b) One context: after Storacha + manifest, clearing selected `localStorage` keys simulates “no
 * local registry hints”. A second isolated Playwright context **cannot** share the virtual passkey;
 * IPNS recovery is tested in the same context after reload.
 */
test.describe('Worker Ed25519 — passkey recovery', () => {
  test.describe.configure({ timeout: 240_000 });
  test('(a) Alice reload + Recover: local OrbitDB path; two linked devices still listed', async ({
    browser,
  }, testInfo) => {
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

    await addVirtualWebAuthn(alice, alicePage, { signingPreference: WORKER });
    await addVirtualWebAuthn(bob, bobPage, { signingPreference: WORKER });

    await createPasskeyAndOpenP2PTab(alicePage, { signingPreference: WORKER });
    await createPasskeyAndOpenP2PTab(bobPage, { signingPreference: WORKER });

    await pairBobWithAlice(alicePage, bobPage);

    await expectLinkedDeviceRowCount(alicePage, 2);
    await expectLinkedDeviceRowCount(bobPage, 2);

    await alicePage.reload({ waitUntil: 'domcontentloaded' });

    await recoverPasskeyFromPreAuth(alicePage, { signingPreference: WORKER });
    await expectLinkedDeviceRowCount(alicePage, 2);

    await alice.close();
    await bob.close();
  });

  test('(b) cleared local cache + reload: Recover via IPNS (requires Storacha delegation env)', async ({
    browser,
  }, testInfo) => {
    const delegation = process.env.E2E_STORACHA_DELEGATION?.trim();
    test.skip(
      !delegation,
      'Set E2E_STORACHA_DELEGATION (env or GitHub Actions secret) to a valid Storacha UCAN delegation, or run: npm run test:e2e:recovery-ipns with that env set'
    );

    const baseURL = testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';
    const ctx = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();

    await addVirtualWebAuthn(ctx, page, { signingPreference: WORKER });
    await createPasskeyAndOpenP2PTab(page, {
      signingPreference: WORKER,
      passkeyUserLabel: 'e2e-ipns-recovery-worker',
    });

    await importStorachaDelegationForE2e(page, delegation);

    await page.evaluate((keys) => {
      for (const k of keys) {
        try {
          localStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      }
    }, E2E_LOCAL_RECOVERY_CACHE_KEYS);

    await page.reload({ waitUntil: 'domcontentloaded' });

    await recoverPasskeyFromPreAuth(page, { signingPreference: WORKER });

    await expect(page.getByTestId('storacha-post-auth')).toBeVisible();
    await expect(page.getByText(/Worker Ed25519/i).first()).toBeVisible();

    await ctx.close();
  });
});
