import { test, expect } from '@playwright/test';
import {
	SEED_A,
	authenticate,
	createContextWithMock,
	getWidgetState,
	readClipboard,
	waitForDeviceCount
} from './helpers/e2e.js';

test.describe('Widget E2E', () => {
	test('shows p2p passkeys as the first tab after authentication', async ({ browser }) => {
		const context = await createContextWithMock(browser, SEED_A);
		const page = await context.newPage();

		try {
			await authenticate(page);

			const passkeysTab = page.getByTestId('tab-passkeys').first();
			const storachaTab = page.getByTestId('tab-storacha').first();
			const passkeysBox = await passkeysTab.boundingBox();
			const storachaBox = await storachaTab.boundingBox();

			expect(passkeysBox).toBeTruthy();
			expect(storachaBox).toBeTruthy();
			expect(passkeysBox.x).toBeLessThan(storachaBox.x);

			const state = await getWidgetState(page);
			expect(state.activeTab).toBe('passkeys');
			await expect(page.getByText('Linked Devices')).toBeVisible();
		} finally {
			await context.close().catch(() => {});
		}
	});

	test('switches between passkeys and storacha tabs', async ({ browser }) => {
		const context = await createContextWithMock(browser, SEED_A);
		const page = await context.newPage();

		try {
			await authenticate(page);

			await page.getByTestId('tab-storacha').first().click();
			await expect(page.getByText('Import UCAN Delegation')).toBeVisible();
			await expect(page.getByText('Linked Devices')).toBeHidden();

			await page.getByTestId('tab-passkeys').first().click();
			await expect(page.getByText('Linked Devices')).toBeVisible();
			await expect(page.getByTestId('link-device-button').first()).toBeVisible();
		} finally {
			await context.close().catch(() => {});
		}
	});

	test('shows and copies the authenticated DID', async ({ browser }) => {
		const context = await createContextWithMock(browser, SEED_A);
		const page = await context.newPage();

		try {
			await authenticate(page);

			const did = await page.getByTestId('did-display').getAttribute('data-full-did');
			expect(did).toMatch(/^did:key:/);

			await page.getByTestId('copy-did').click();
			await expect(page.getByText('DID copied to clipboard!')).toBeVisible();
			await expect.poll(() => readClipboard(page)).toBe(did);
		} finally {
			await context.close().catch(() => {});
		}
	});

	test('shows the initial linked device and copies peer info', async ({ browser }) => {
		const context = await createContextWithMock(browser, SEED_A);
		const page = await context.newPage();

		try {
			await authenticate(page);
			await waitForDeviceCount(page, 1);

			await expect(page.getByTestId('linked-devices-count').last()).toContainText('1');

			const state = await getWidgetState(page);
			expect(state.did).toMatch(/^did:key:/);
			expect(state.deviceCount).toBeGreaterThanOrEqual(1);

			await page.getByTestId('copy-peer-info').last().click();
			await expect(page.getByText('Peer info copied to clipboard!')).toBeVisible();

			const clipboardText = await readClipboard(page);
			const peerInfo = JSON.parse(clipboardText);
			expect(peerInfo.peerId).toBeTruthy();
			expect(Array.isArray(peerInfo.multiaddrs)).toBe(true);
		} finally {
			await context.close().catch(() => {});
		}
	});

	test('shows an error when invalid peer info JSON is submitted', async ({ browser }) => {
		const context = await createContextWithMock(browser, SEED_A);
		const page = await context.newPage();

		try {
			await authenticate(page);

			await page.getByTestId('link-peer-info-input').last().fill('{invalid json');
			await page.getByTestId('link-device-button').last().click();
			await expect(page.getByText(/Failed to link:/)).toBeVisible();
		} finally {
			await context.close().catch(() => {});
		}
	});
});
