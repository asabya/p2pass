import { test, expect } from '@playwright/test';
import {
	SEED_A,
	SEED_B,
	authenticate,
	createContextWithMock,
	getWidgetState,
	waitForDeviceCount,
	waitForWidgetApi
} from './helpers/e2e.js';

test.describe('P2P Passkeys Multi-Device E2E', () => {
	test('creates different DIDs in separate browser contexts', async ({ browser }) => {
		const contextA = await createContextWithMock(browser, SEED_A);
		const contextB = await createContextWithMock(browser, SEED_B);
		const pageA = await contextA.newPage();
		const pageB = await contextB.newPage();

		try {
			await Promise.all([authenticate(pageA), authenticate(pageB)]);

			const [stateA, stateB] = await Promise.all([getWidgetState(pageA), getWidgetState(pageB)]);
			expect(stateA.did).toMatch(/^did:key:/);
			expect(stateB.did).toMatch(/^did:key:/);
			expect(stateA.did).not.toBe(stateB.did);
		} finally {
			await contextA.close().catch(() => {});
			await contextB.close().catch(() => {});
		}
	});

	test('shows a pairing request prompt and adds the second device after approval', async ({ browser }) => {
		const contextA = await createContextWithMock(browser, SEED_A);
		const contextB = await createContextWithMock(browser, SEED_B);
		const pageA = await contextA.newPage();
		const pageB = await contextB.newPage();

		try {
			await Promise.all([authenticate(pageA), authenticate(pageB)]);
			await Promise.all([waitForWidgetApi(pageA), waitForWidgetApi(pageB)]);
			await Promise.all([waitForDeviceCount(pageA, 1), waitForDeviceCount(pageB, 1)]);

			const stateB = await getWidgetState(pageB);
			const request = {
				type: 'request',
				identity: {
					id: stateB.did,
					credentialId: 'mock-seed-b-credential-id',
					deviceLabel: 'Device B (Playwright)',
					publicKey: null
				}
			};

			await pageA.evaluate((payload) => window.__p2pPasskeysWidget.beginIncomingPairingRequest(payload), request);
			await expect(pageA.getByText('Device Pairing Request')).toBeVisible();
			await expect(pageA.getByText('Device B (Playwright)')).toBeVisible();

			await pageA.getByTestId('approve-pairing').click();

			const result = await pageA.evaluate(() => window.__p2pPasskeysWidget.waitForPendingPairingResult());
			expect(result.type).toBe('granted');
			expect(result.orbitdbAddress).toMatch(/^\/orbitdb\//);

			await expect
				.poll(async () => {
					const devices = await pageA.evaluate(() => window.__p2pPasskeysWidget.listDevices());
					return devices.length;
				})
				.toBe(2);

			await expect(pageA.getByTestId('linked-devices-count').first()).toContainText('2');

			const linkedDevices = await pageA.evaluate(() => window.__p2pPasskeysWidget.listDevices());
			expect(linkedDevices).toHaveLength(2);
			expect(linkedDevices.some((device) => device.ed25519_did === stateB.did)).toBe(true);
		} finally {
			await contextA.close().catch(() => {});
			await contextB.close().catch(() => {});
		}
	});

	test('auto-grants known devices without reopening the approval prompt', async ({ browser }) => {
		const contextA = await createContextWithMock(browser, SEED_A);
		const contextB = await createContextWithMock(browser, SEED_B);
		const pageA = await contextA.newPage();
		const pageB = await contextB.newPage();

		try {
			await Promise.all([authenticate(pageA), authenticate(pageB)]);
			await waitForDeviceCount(pageA, 1);

			const stateB = await getWidgetState(pageB);
			const request = {
				type: 'request',
				identity: {
					id: stateB.did,
					credentialId: 'mock-seed-b-credential-id',
					deviceLabel: 'Device B (Playwright)',
					publicKey: null
				}
			};

			const firstGrant = await pageA.evaluate((payload) => window.__p2pPasskeysWidget.simulateIncomingPairingRequest(payload, 'granted'), request);
			expect(firstGrant.type).toBe('granted');

			const secondGrant = await pageA.evaluate((payload) => window.__p2pPasskeysWidget.simulateIncomingPairingRequest(payload, 'rejected'), request);
			expect(secondGrant.type).toBe('granted');
			await expect(pageA.getByText('Device Pairing Request')).toBeHidden();
		} finally {
			await contextA.close().catch(() => {});
			await contextB.close().catch(() => {});
		}
	});
});
