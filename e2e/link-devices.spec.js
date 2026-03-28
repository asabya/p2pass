import { test, expect } from '@playwright/test';
import {
	addVirtualWebAuthn,
	createPasskeyAndOpenP2PTab,
	copyPeerInfoFromClipboard
} from './helpers.js';

test.describe('P2P link devices (local relay)', () => {
	test('Alice and Bob passkeys, paste peer JSON, approve, both see linked devices', async ({
		browser
	}, testInfo) => {
		// Manual `browser.newContext()` does not inherit `use.baseURL` from playwright.config.js.
		// Without this, `page.goto('/')` is invalid and the app (and WebAuthn) never load reliably.
		const baseURL =
			testInfo.project.use.baseURL?.replace(/\/$/, '') || 'http://localhost:5173';

		const alice = await browser.newContext({
			baseURL,
			permissions: ['clipboard-read', 'clipboard-write']
		});
		const bob = await browser.newContext({
			baseURL,
			permissions: ['clipboard-read', 'clipboard-write']
		});

		const alicePage = await alice.newPage();
		const bobPage = await bob.newPage();

		await addVirtualWebAuthn(alice, alicePage);
		await addVirtualWebAuthn(bob, bobPage);

		await createPasskeyAndOpenP2PTab(alicePage);
		await createPasskeyAndOpenP2PTab(bobPage);

		const alicePeerJson = await copyPeerInfoFromClipboard(alicePage);
		expect(alicePeerJson).toContain('"peerId"');
		expect(alicePeerJson).toContain('"multiaddrs"');

		await bobPage.getByTestId('storacha-link-peer-input').first().fill(alicePeerJson);
		await bobPage.getByTestId('storacha-link-device-submit').first().click();

		await alicePage.getByTestId('storacha-pairing-approve').click({ timeout: 120_000 });

		const row = alicePage.locator('[data-testid="storacha-linked-device-row"]');
		await expect(row).toHaveCount(2, { timeout: 120_000 });
		await expect(bobPage.locator('[data-testid="storacha-linked-device-row"]')).toHaveCount(2, {
			timeout: 120_000
		});

		await alice.close();
		await bob.close();
	});
});
