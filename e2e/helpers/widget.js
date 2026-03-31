import { expect } from '@playwright/test';

export const SEED_A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
export const SEED_B = [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
export const SEED_C = [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48];

export function webAuthnMockScript({ seed }) {
  window.__P2P_PASSKEYS_E2E__ = true;
  window.__testMode = true;

  const mockCredentialId = new Uint8Array(seed);
  const credentialLabel = `mock-cred-${seed.join('-')}`;

  if (!window.PublicKeyCredential) {
    window.PublicKeyCredential = function PublicKeyCredential() {};
  }

  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  window.PublicKeyCredential.isConditionalMediationAvailable = async () => true;

  if (!window.navigator.credentials) {
    window.navigator.credentials = {};
  }

  window.navigator.credentials.create = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, 50));

    const mockAttestation = new Uint8Array(300);
    mockAttestation.set([
      0xa3, 0x63, 0x66, 0x6d, 0x74, 0x66, 0x70, 0x61, 0x63, 0x6b, 0x65, 0x64, 0x67, 0x61, 0x74,
      0x74, 0x53, 0x74, 0x6d, 0x74, 0xa0, 0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61,
    ]);

    const extensionResults = {};
    if (options?.publicKey?.extensions?.prf) {
      extensionResults.prf = { enabled: true };
    }
    if (options?.publicKey?.extensions?.hmacCreateSecret) {
      extensionResults.hmacCreateSecret = true;
    }

    return {
      id: credentialLabel,
      rawId: mockCredentialId,
      type: 'public-key',
      response: {
        attestationObject: mockAttestation,
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: 'mock-challenge',
            origin: window.location.origin,
            crossOrigin: false,
          })
        ),
        getPublicKey: () => new Uint8Array(65),
        getPublicKeyAlgorithm: () => -7,
      },
      getClientExtensionResults: () => extensionResults,
    };
  };

  window.navigator.credentials.get = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, 50));

    const extensionResults = {};
    if (options?.publicKey?.extensions?.prf) {
      const prfOutput = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        prfOutput[i] = (mockCredentialId[i % mockCredentialId.length] + i) % 256;
      }
      extensionResults.prf = { results: { first: prfOutput } };
    }
    if (options?.publicKey?.extensions?.hmacGetSecret) {
      extensionResults.hmacGetSecret = { output1: new Uint8Array(32).fill(42) };
    }

    return {
      id: credentialLabel,
      rawId: mockCredentialId,
      type: 'public-key',
      response: {
        authenticatorData: new Uint8Array(37),
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.get',
            challenge: 'mock-challenge',
            origin: window.location.origin,
            crossOrigin: false,
          })
        ),
        signature: new Uint8Array(64),
        userHandle: null,
      },
      getClientExtensionResults: () => extensionResults,
    };
  };
}

export async function createContextWithMock(browser, seed) {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(webAuthnMockScript, { seed });
  return context;
}

export async function gotoExample(page) {
  await page.goto('/');
  await expect(page.getByTestId('storacha-fab-toggle')).toBeVisible({ timeout: 30000 });
  await waitForWidgetApi(page);
}

export async function openWidget(page) {
  await gotoExample(page);
  await page.getByTestId('storacha-fab-toggle').click();
  await expect(page.getByTestId('storacha-panel')).toBeVisible();
}

export async function waitForWidgetApi(page, timeout = 30000) {
  await page.waitForFunction(() => typeof window.__p2pPasskeysWidget !== 'undefined', { timeout });
}

export async function authenticate(page) {
  await openWidget(page);
  await page.getByTestId('storacha-passkey-primary').click();
  await expect(page.getByTestId('storacha-your-did')).toBeVisible({ timeout: 120000 });
  await page.waitForFunction(
    () => {
      const state = window.__p2pPasskeysWidget?.getState?.();
      return !!state?.did;
    },
    { timeout: 120000 }
  );
}

export async function waitForDeviceCount(page, expectedCount, timeout = 120000) {
  await page.waitForFunction(
    (count) => {
      const state = window.__p2pPasskeysWidget?.getState?.();
      return (state?.deviceCount || 0) >= count;
    },
    expectedCount,
    { timeout }
  );
}

export async function getWidgetState(page) {
  return page.evaluate(() => window.__p2pPasskeysWidget.getState());
}

export async function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}
