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
export function signingPreferenceRadioTestId(mode) {
  if (mode === 'hardware-ed25519') return 'storacha-signing-pref-hardware-ed25519';
  if (mode === 'hardware-p256') return 'storacha-signing-pref-hardware-p256';
  return 'storacha-signing-pref-worker';
}

/** localStorage keys to drop so recovery cannot use the local OrbitDB fast path (forces IPNS / manifest). */
export const E2E_LOCAL_RECOVERY_CACHE_KEYS = [
  'p2p_passkeys_owner_did',
  'p2p_passkeys_registry_address',
  'p2p_passkeys_worker_archive',
  'p2p_passkeys_ipns_revision',
  'storacha_ucan_delegation',
];

/**
 * Open panel, choose signing mode, authenticate. Call after {@link addVirtualWebAuthn}.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ signingPreference?: string, passkeyUserLabel?: string }} [options] - defaults from `E2E_SIGNING_MODE` / `worker`
 */
export async function createPasskeyAndOpenP2PTab(page, options = {}) {
  const mode = resolveE2eSigningPreference(options);

  await expect(page).toHaveURL(/localhost/);
  await page.getByTestId('storacha-fab-toggle').click();
  await expect(page.getByTestId('storacha-panel')).toBeVisible();

  await expect(page.getByTestId('storacha-signing-preference-group')).toBeVisible();
  await page.getByTestId(signingPreferenceRadioTestId(mode)).click();
  await expect(page.getByTestId(signingPreferenceRadioTestId(mode))).toBeChecked();

  const label = options.passkeyUserLabel?.trim();
  if (label) {
    await page.getByTestId('storacha-passkey-user-label').fill(label);
  }

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
 * Open the Storacha panel (if needed), select Worker Ed25519, click Recover Passkey, wait for auth shell.
 * Use after a page reload when the virtual authenticator still holds the passkey (same browser context).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ signingPreference?: 'hardware-ed25519' | 'hardware-p256' | 'worker' }} [options]
 */
export async function recoverPasskeyFromPreAuth(page, options = {}) {
  const mode = resolveE2eSigningPreference(options);

  await page.getByTestId('storacha-fab-toggle').click();
  await expect(page.getByTestId('storacha-panel')).toBeVisible();
  await expect(page.getByTestId('storacha-signing-preference-group')).toBeVisible();
  await page.getByTestId(signingPreferenceRadioTestId(mode)).click();
  await expect(page.getByTestId(signingPreferenceRadioTestId(mode))).toBeChecked();

  await page.getByTestId('storacha-recover-passkey').click();
  await expect(page.getByTestId('storacha-post-auth')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('storacha-link-device-submit').first()).toHaveAttribute(
    'data-mdm-ready',
    'true',
    { timeout: 120_000 }
  );
}

/** OrbitDB device list can flicker while replicating; require this many consecutive polls at `count`. */
const LINKED_ROWS_STABLE_TICKS = 5;
const LINKED_ROWS_POLL_MS = 500;
const LINKED_ROWS_TIMEOUT_MS = 120_000;

/**
 * Assert linked-device rows inside the main panel only (avoids stray matches) and wait until the
 * count matches `count` on several consecutive polls — replication often oscillates before settling.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} count
 */
export async function expectLinkedDeviceRowCount(page, count) {
  await ensureStorachaPanelOpen(page);
  await page.getByTestId('storacha-tab-passkeys').first().click();

  const rows = page.getByTestId('storacha-panel').getByTestId('storacha-linked-device-row');
  const deadline = Date.now() + LINKED_ROWS_TIMEOUT_MS;
  let stable = 0;

  while (Date.now() < deadline) {
    const n = await rows.count();
    if (n === count) {
      stable += 1;
      if (stable >= LINKED_ROWS_STABLE_TICKS) {
        await expect(rows).toHaveCount(count);
        return;
      }
    } else {
      stable = 0;
    }
    await new Promise((r) => setTimeout(r, LINKED_ROWS_POLL_MS));
  }

  await expect(rows).toHaveCount(count, { timeout: 5_000 });
}

/**
 * Ensure the floating panel is open (pairing prompt is mounted but may be inside a closed panel).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureStorachaPanelOpen(page) {
  const panel = page.getByTestId('storacha-panel');
  if (!(await panel.isVisible())) {
    await page.getByTestId('storacha-fab-toggle').click();
  }
  await expect(panel).toBeVisible();
}

/** Max "Link Device" clicks (transient P2P / pairing; Bob may show `data-testid="storacha-link-error"`). */
const LINK_DEVICE_MAX_ATTEMPTS = 5;
/** Per-attempt wait for Alice’s pairing prompt or Bob’s error before retrying. */
const LINK_DEVICE_ATTEMPT_MS = 45_000;

/**
 * Alice approves Bob’s pairing request (same flow as `link-devices.spec.js`).
 * If Bob shows a link error (red label), clicks "Link Device" again (up to `LINK_DEVICE_MAX_ATTEMPTS` times).
 *
 * @param {import('@playwright/test').Page} alicePage
 * @param {import('@playwright/test').Page} bobPage
 */
export async function pairBobWithAlice(alicePage, bobPage) {
  const alicePayload = await getLinkPayloadJsonForE2e(alicePage);
  expect(alicePayload).toContain('"multiaddrs"');

  await ensureStorachaPanelOpen(alicePage);
  await bobPage.bringToFront();
  await ensureStorachaPanelOpen(bobPage);

  let paired = false;

  for (let attempt = 0; attempt < LINK_DEVICE_MAX_ATTEMPTS && !paired; attempt++) {
    await bobPage.bringToFront();
    await ensureStorachaPanelOpen(bobPage);
    await bobPage.getByTestId('storacha-tab-passkeys').first().click();

    const peerInput = bobPage.getByTestId('storacha-link-peer-input').first();
    await peerInput.fill(alicePayload);
    const linkBtn = bobPage.getByRole('button', { name: 'Link Device' });
    await expect(linkBtn).toBeEnabled({ timeout: 60_000 });
    await linkBtn.click();

    const errorLoc = bobPage.getByTestId('storacha-link-error');
    const promptLoc = alicePage.getByTestId('storacha-pairing-prompt');
    const deadline = Date.now() + LINK_DEVICE_ATTEMPT_MS;

    while (Date.now() < deadline) {
      if (await promptLoc.isVisible()) {
        paired = true;
        break;
      }
      if (await errorLoc.isVisible()) {
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!paired && (await promptLoc.isVisible())) {
      paired = true;
    }

    if (!paired && !(await errorLoc.isVisible()) && Date.now() >= deadline) {
      // No prompt and no error text — treat as soft failure and retry (e.g. dial still in flight).
      continue;
    }
  }

  await alicePage.bringToFront();
  await ensureStorachaPanelOpen(alicePage);
  await expect(alicePage.getByTestId('storacha-pairing-prompt')).toBeVisible({ timeout: 30_000 });
  await alicePage.getByTestId('storacha-pairing-approve').click({ timeout: 120_000 });
}

/**
 * Import Storacha delegation from the post-auth UI (Storacha tab) and wait for connect + manifest publish kickoff.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} delegationRaw
 */
export async function importStorachaDelegationForE2e(page, delegationRaw) {
  await page.getByTestId('storacha-tab-storacha').first().click();
  await page.getByTestId('storacha-delegation-textarea').fill(delegationRaw.trim());
  await page.getByTestId('storacha-delegation-import').click();
  await expect(page.getByText(/Connected to Storacha/i)).toBeVisible({ timeout: 120_000 });
  // publishManifest is async; w3name/IPFS need time before a subsequent IPNS-only recovery.
  await page.waitForTimeout(8000);
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
          const w =
            /** @type {typeof globalThis & { __p2passE2E?: { getPeerInfo?: () => { peerId?: string; multiaddrs?: string[] } } }} */ (
              globalThis
            );
          const api = w.__p2passE2E;
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
