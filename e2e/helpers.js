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
			isUserVerified: true
		}
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

	await expect(
		page.getByText(/Worker Ed25519|Hardware Ed25519|Hardware P-256/)
	).toBeVisible({ timeout: 120_000 });

	await page.getByTestId('storacha-tab-passkeys').first().click();

	await expect(page.getByTestId('storacha-copy-peer-info').first()).toBeVisible({
		timeout: 120_000
	});

	// Link button stays disabled while the textarea is empty (`linkDeviceDisabled` includes
	// `!linkInput.trim()`). Wait for MultiDeviceManager only — paste JSON before clicking.
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
			return text.includes('"peerId"') && text.includes('"multiaddrs"');
		})
		.toBe(true);
	return text;
}
