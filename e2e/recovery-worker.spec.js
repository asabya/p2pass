import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  addVirtualWebAuthn,
  createPasskeyAndOpenP2PTab,
  recoverPasskeyFromPreAuth,
  expectLinkedDeviceRowCount,
  pairBobWithAlice,
  importStorachaDelegationForE2e,
  E2E_LOCAL_RECOVERY_CACHE_KEYS,
  resolveE2eSigningPreference,
} from './helpers.js';

/** Same values as CI matrix `E2E_SIGNING_MODE` (`worker` | `hardware-ed25519` | `hardware-p256`). Virtual WebAuthn supports all three. */
const signingMode = resolveE2eSigningPreference();
const E2E_DIR = dirname(fileURLToPath(import.meta.url));

/** Linked-device replication can be slow in CI. */
const LINKED_ROWS_WAIT = { timeoutMs: 240_000, finalTimeoutMs: 45_000 };

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
test.describe(`Passkey recovery — ${signingMode}`, () => {
  test.describe.configure({ timeout: 300_000 });
  test('(a) Alice reload + Recover: local OrbitDB path; two linked devices still listed', async ({
    browser,
  }, testInfo) => {
    test.skip(
      !!process.env.GITHUB_ACTIONS,
      'Linked-device replication after pairing is flaky on GitHub Actions; run `npm run test:e2e` locally to cover this path.'
    );

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

    await expectLinkedDeviceRowCount(alicePage, 2, LINKED_ROWS_WAIT);
    await expectLinkedDeviceRowCount(bobPage, 2, LINKED_ROWS_WAIT);

    await alicePage.reload({ waitUntil: 'load' });
    await alicePage.getByTestId('storacha-fab-toggle').waitFor({ state: 'visible', timeout: 120_000 });

    await recoverPasskeyFromPreAuth(alicePage, { signingPreference: signingMode });
    await expectLinkedDeviceRowCount(alicePage, 2, LINKED_ROWS_WAIT);

    await alice.close();
    await bob.close();
  });

  /**
   * In-memory upload-api (see `e2e/local-storacha-api`, `storacha-e2e-bootstrap.mjs`) + Vite
   * `VITE_STORACHA_*` — same pattern as ucan-upload-wall. Mints a UCAN for the post-auth DID and
   * checks Storacha connects without production credentials.
   */
  test('(b-inmemory) mint UCAN + import: Storacha connects against local upload-api', async ({
    browser,
  }, testInfo) => {
    const storachaMetaPath = join(E2E_DIR, '.storacha-e2e.json');
    test.skip(
      !existsSync(storachaMetaPath),
      'Run Playwright with scripts/e2e-with-relay.mjs (writes e2e/.storacha-e2e.json)'
    );

    const baseURL = testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';
    const ctx = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();

    await addVirtualWebAuthn(ctx, page, { signingPreference: signingMode });
    await createPasskeyAndOpenP2PTab(page, {
      signingPreference: signingMode,
      passkeyUserLabel: 'e2e-inmemory-storacha',
    });

    const meta = JSON.parse(readFileSync(storachaMetaPath, 'utf8'));
    const audienceDid = await page
      .getByTestId('storacha-your-did')
      .getAttribute('data-storacha-did-full');
    if (!audienceDid?.startsWith('did:')) {
      throw new Error('Missing data-storacha-did-full');
    }
    const res = await fetch(`${meta.delegationHelperUrl}/delegation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audienceDid }),
    });
    if (!res.ok) {
      throw new Error(`delegation helper: ${res.status} ${await res.text()}`);
    }
    const { delegation } = await res.json();
    await importStorachaDelegationForE2e(page, delegation);

    await ctx.close();
  });

  /**
   * Full IPNS-shaped recovery with `VITE_RECOVERY_MOCK_IPNS=1`: UCAN + Storacha (in-memory upload-api),
   * publish manifest + archive via real `uploadFile`, but w3name/gateway are stubbed in localStorage.
   * Then clear local hints and recover — same as production flow without real IPNS.
   */
  test('(b-ipns-mock) full path: delegation → publish → clear cache → recover via IPNS mock', async ({
    browser,
  }, testInfo) => {
    const storachaMetaPath = join(E2E_DIR, '.storacha-e2e.json');
    test.skip(
      !existsSync(storachaMetaPath),
      'Run Playwright with scripts/e2e-with-relay.mjs (VITE_RECOVERY_MOCK_IPNS + in-memory Storacha)'
    );

    const baseURL = testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';
    const ctx = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();

    await addVirtualWebAuthn(ctx, page, { signingPreference: signingMode });
    await createPasskeyAndOpenP2PTab(page, {
      signingPreference: signingMode,
      passkeyUserLabel: 'e2e-ipns-mock-recovery',
    });

    const meta = JSON.parse(readFileSync(storachaMetaPath, 'utf8'));
    const audienceDid = await page
      .getByTestId('storacha-your-did')
      .getAttribute('data-storacha-did-full');
    if (!audienceDid?.startsWith('did:')) {
      throw new Error('Missing data-storacha-did-full');
    }
    const res = await fetch(`${meta.delegationHelperUrl}/delegation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audienceDid }),
    });
    if (!res.ok) {
      throw new Error(`delegation helper: ${res.status} ${await res.text()}`);
    }
    const { delegation } = await res.json();
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

    await recoverPasskeyFromPreAuth(page, { signingPreference: signingMode });

    await expect(page.getByTestId('storacha-your-did').first()).toHaveAttribute(
      'data-storacha-did-full',
      audienceDid
    );

    await ctx.close();
  });

  /**
   * Clears local OrbitDB/recovery hints to force the IPNS recovery path against **production**
   * w3name + gateway. Requires `E2E_STORACHA_DELEGATION` and a published manifest.
   */
  test('(b-ipns) cleared local cache + reload: Recover via IPNS (requires delegation env + manifest)', async ({
    browser,
  }, testInfo) => {
    const delegationRaw = process.env.E2E_STORACHA_DELEGATION?.trim();
    test.skip(
      !delegationRaw,
      'Set E2E_STORACHA_DELEGATION to a delegation whose space has a published recovery manifest (IPNS), or run npm run test:e2e:recovery-ipns with that env'
    );
    const delegation = /** @type {string} */ (delegationRaw);

    const baseURL = testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';
    const ctx = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();

    await addVirtualWebAuthn(ctx, page, { signingPreference: signingMode });
    await createPasskeyAndOpenP2PTab(page, {
      signingPreference: signingMode,
      passkeyUserLabel: 'e2e-ipns-recovery-worker',
    });

    await importStorachaDelegationForE2e(page, delegation);

    const expectedDid = await page
      .getByTestId('storacha-your-did')
      .first()
      .getAttribute('data-storacha-did-full');
    if (!expectedDid?.startsWith('did:')) {
      throw new Error('Missing data-storacha-did-full before cache clear');
    }

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

    await recoverPasskeyFromPreAuth(page, { signingPreference: signingMode });

    await expect(page.getByTestId('storacha-your-did').first()).toHaveAttribute(
      'data-storacha-did-full',
      expectedDid
    );

    await ctx.close();
  });
});
