<script>
	import { onMount } from 'svelte';
	import { Upload, LogOut, Loader2, AlertCircle, CheckCircle, Download } from 'lucide-svelte';
	import {
		listSpaces,
		getSpaceUsage
	} from './storacha-backup.js';
	import { OrbitDBStorachaBridge } from 'orbitdb-storacha-bridge';
	import { IdentityService } from '../identity/identity-service.js';
	import { createStorachaClient, parseDelegation, storeDelegation, loadStoredDelegation, clearStoredDelegation } from '../ucan/storacha-auth.js';
	import { openDeviceRegistry, registerDevice, listDevices as listRegistryDevices, getArchiveEntry, listKeypairs } from '../registry/device-registry.js';
	import { deriveIPNSKeyPair } from '../recovery/ipns-key.js';
	import { createManifest, publishManifest, resolveManifest, uploadArchiveToIPFS, fetchArchiveFromIPFS } from '../recovery/manifest.js';
	import { backupRegistryDb, restoreRegistryDb } from '../backup/registry-backup.js';
	import { MultiDeviceManager } from '../registry/manager.js';
	import { detectDeviceLabel } from '../registry/pairing-protocol.js';
	import { loadWebAuthnCredentialSafe } from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';
	import './fonts/storacha-fonts.css';

	let {
		orbitdb = null,
		database = null,
		isInitialized = false,
		entryCount = 0,
		databaseName = 'restored-db',
		onRestore = () => {},
		onBackup = () => {},
		onAuthenticate = () => {},
		libp2p = null,
		preferWorkerMode = false
	} = $props();

	// Component state
	let showStoracha = $state(true);
	let isLoading = $state(false);
	let status = $state('');
	let error = $state(null);
	let success = $state(null);

	// Auth state
	let isLoggedIn = $state(false);
	let client = $state(null);
	let currentSpace = $state(null);

	// Progress tracking state
	let showProgress = $state(false);
	let progressType = $state('');
	let progressCurrent = $state(0);
	let progressTotal = $state(0);
	let progressPercentage = $state(0);
	let progressCurrentBlock = $state(null);
	let progressError = $state(null);

	// Bridge instance
	let bridge = null;

	// Passkey + UCAN state
	let identityService = new IdentityService();
	let signingMode = $state(null); // { mode, did, algorithm, secure }
	let delegationText = $state(''); // textarea for pasting delegation
	let isAuthenticating = $state(false);
	let spaces = $state([]);
	let spaceUsage = $state(null);

	// Registry DB state
	let registryDb = $state(null);
	const REGISTRY_ADDRESS_KEY = 'p2p_passkeys_registry_address';

	// Tab state
	let activeTab = $state('storacha'); // 'storacha' | 'passkeys'

	// P2P Passkeys state
	let devices = $state([]);
	let peerInfo = $state(null);
	let linkInput = $state('');
	let isLinking = $state(false);
	let linkError = $state('');
	let deviceManager = $state(null);

	// Recovery state
	let isRecovering = $state(false);
	let recoveryStatus = $state('');
	let ipnsKeyPair = $state(null);
	let ipnsNameString = $state('');

	function resetProgress() {
		showProgress = false;
		progressType = '';
		progressCurrent = 0;
		progressTotal = 0;
		progressPercentage = 0;
		progressCurrentBlock = null;
		progressError = null;
	}

	function showMessage(message, type = 'info') {
		if (type === 'error') {
			error = message;
			success = null;
		} else {
			success = message;
			error = null;
		}
		setTimeout(() => {
			error = null;
			success = null;
		}, 5000);
	}

	function clearForms() {
		delegationText = '';
	}

	async function handleAuthenticate() {
		isAuthenticating = true;
		try {
			signingMode = await identityService.initialize(undefined, { preferWorkerMode });
			showMessage(`Authenticated! Mode: ${signingMode.algorithm} (${signingMode.mode})`);

			// Notify parent that authentication succeeded — await so P2P stack can init
			await onAuthenticate(signingMode);

			// Derive IPNS keypair for manifest operations
			const kp = identityService.getIPNSKeyPair();
			if (kp) ipnsKeyPair = kp;

			// Open/create registry DB if OrbitDB is available
			await initRegistryDb();

			// Try auto-connect if delegation is stored
			const stored = await loadStoredDelegation(registryDb);
			if (stored) await handleConnectWithDelegation(stored);
		} catch (err) {
			showMessage(`Authentication failed: ${err.message}`, 'error');
		} finally {
			isAuthenticating = false;
		}
	}

	async function handleRecover() {
		isRecovering = true;
		recoveryStatus = 'Authenticating with passkey...';
		try {
			// Step 1: Recover PRF seed via discoverable credential
			const recovery = await identityService.initializeFromRecovery();
			ipnsKeyPair = recovery.ipnsKeyPair;
			recoveryStatus = 'Resolving IPNS manifest...';

			// Step 2: Resolve manifest from w3name
			const manifest = await resolveManifest(recovery.ipnsKeyPair.privateKey);
			if (!manifest) {
				throw new Error('No recovery manifest found. This identity may not have been backed up yet.');
			}

			// Step 3: Restore DID from IPFS archive (no auth needed — public gateway)
			if (!manifest.archiveCID) {
				throw new Error('Manifest has no archiveCID. Cannot restore identity without it.');
			}
			recoveryStatus = 'Fetching encrypted archive...';
			const archiveEntry = await fetchArchiveFromIPFS(manifest.archiveCID);
			if (!archiveEntry) {
				throw new Error('Failed to fetch encrypted archive from IPFS.');
			}

			recoveryStatus = 'Restoring identity...';
			await identityService.restoreFromManifest(archiveEntry, manifest.ownerDid);
			signingMode = identityService.getSigningMode();

			// Step 4: Start P2P stack (DID is restored, P2P uses default OrbitDB identity)
			recoveryStatus = 'Starting P2P stack...';
			await onAuthenticate(signingMode);

			// Step 5: Connect Storacha directly (skip registry writes — no write access)
			// The delegation and DID come from the manifest, not the registry.
			if (manifest.delegation) {
				recoveryStatus = 'Connecting to Storacha...';
				const delegation = await parseDelegation(manifest.delegation);
				const principal = await identityService.getPrincipal();
				client = await createStorachaClient(principal, delegation);

				// Store delegation in localStorage only (registry not writable)
				const spaceDid = client.currentSpace()?.did?.() || '';
				await storeDelegation(manifest.delegation, null, spaceDid);

				currentSpace = client.currentSpace();
				isLoggedIn = true;

				// Set up bridge
				bridge = new OrbitDBStorachaBridge({ ucanClient: client });
				if (currentSpace) bridge.spaceDID = currentSpace.did();
				setupBridgeListeners();
				await loadSpaceUsage();
			}

			recoveryStatus = '';
			showMessage('Identity recovered successfully!');
		} catch (err) {
			showMessage(`Recovery failed: ${err.message}`, 'error');
			recoveryStatus = '';
			signingMode = null;
		} finally {
			isRecovering = false;
		}
	}

	async function handlePublishManifest() {
		if (!client || !registryDb || !signingMode?.did) return;

		// Derive IPNS keypair if not already available
		if (!ipnsKeyPair) {
			const kp = identityService.getIPNSKeyPair();
			if (!kp) {
				console.warn('[ui] No IPNS keypair available, cannot publish manifest');
				return;
			}
			ipnsKeyPair = kp;
		}

		try {
			const addr = registryDb.address?.toString?.() || registryDb.address;

			// Get the current delegation string
			const delegationStr = await loadStoredDelegation(registryDb);

			// Upload encrypted archive to IPFS for auth-free recovery
			let archiveCID = null;
			const archiveData = await identityService.getEncryptedArchiveData();
			if (archiveData) {
				try {
					archiveCID = await uploadArchiveToIPFS(client, archiveData);
					console.log('[ui] Archive uploaded to IPFS:', archiveCID);
				} catch (err) {
					console.warn('[ui] Failed to upload archive to IPFS:', err.message);
				}
			}

			const manifest = createManifest({
				registryAddress: addr,
				delegation: delegationStr || '',
				ownerDid: signingMode.did,
				archiveCID
			});

			const result = await publishManifest(client, ipnsKeyPair.privateKey, manifest);
			ipnsNameString = result.nameString;
			console.log('[ui] Manifest published:', result.nameString);
		} catch (err) {
			console.warn('[ui] Failed to publish manifest:', err.message);
		}
	}

	async function initRegistryDb() {
		if (!orbitdb || !signingMode?.did) return;
		try {
			const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
			registryDb = await openDeviceRegistry(orbitdb, signingMode.did, storedAddr);

			const addr = registryDb.address?.toString?.() || registryDb.address;
			if (addr) localStorage.setItem(REGISTRY_ADDRESS_KEY, addr);

			await identityService.setRegistry(registryDb);
			console.log('[ui] Registry DB initialized:', addr);
			await initDeviceManager();
		} catch (err) {
			// If a stored address exists but we can't write, it's from a different identity.
			// Clear it and create a fresh registry for this identity.
			const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
			if (storedAddr) {
				console.warn('[ui] Stale registry address, creating new registry:', err.message);
				localStorage.removeItem(REGISTRY_ADDRESS_KEY);
				try {
					registryDb = await openDeviceRegistry(orbitdb, signingMode.did, null);
					const addr = registryDb.address?.toString?.() || registryDb.address;
					if (addr) localStorage.setItem(REGISTRY_ADDRESS_KEY, addr);
					await identityService.setRegistry(registryDb);
					console.log('[ui] New registry DB created:', addr);
					await initDeviceManager();
					return;
				} catch (retryErr) {
					console.warn('[ui] Failed to create new registry:', retryErr.message);
				}
			}
			console.warn('[ui] Failed to init registry DB:', err.message);
		}
	}

	async function initDeviceManager() {
		if (!libp2p || !registryDb || !signingMode?.did) return;
		try {
			const credential = loadWebAuthnCredentialSafe();
			deviceManager = await MultiDeviceManager.createFromExisting({
				credential,
				orbitdb,
				libp2p,
				identity: { id: signingMode.did },
				onDeviceLinked: (device) => {
					devices = devices.filter(d => d.ed25519_did !== device.ed25519_did);
					devices = [...devices, device];
				},
				onDeviceJoined: (peerId) => {
					console.log('[p2p] Peer joined:', peerId);
				}
			});
			const dbAddr = registryDb.address?.toString?.() || registryDb.address;
			if (dbAddr) await deviceManager.openExistingDb(dbAddr);

			// Self-register this device if not already in registry
			if (credential) {
				await registerDevice(registryDb, {
					credential_id: credential.credentialId || credential.id || libp2p.peerId.toString(),
					public_key: credential.publicKey?.x && credential.publicKey?.y
						? { kty: 'EC', crv: 'P-256', x: credential.publicKey.x, y: credential.publicKey.y }
						: null,
					device_label: detectDeviceLabel(),
					created_at: Date.now(),
					status: 'active',
					ed25519_did: signingMode.did
				});
			}

			devices = await deviceManager.listDevices();
			peerInfo = deviceManager.getPeerInfo();
			console.log('[ui] MultiDeviceManager initialized');
		} catch (err) {
			console.warn('[ui] Failed to init MultiDeviceManager:', err.message);
		}
	}

	async function handleTabSwitch(tab) {
		activeTab = tab;
		if (tab === 'passkeys' && registryDb) {
			try {
				devices = await listRegistryDevices(registryDb);
			} catch (err) {
				console.warn('[ui] Failed to load devices:', err.message);
			}
		}
	}

	function handleCopyPeerInfo() {
		const info = peerInfo || (libp2p ? {
			peerId: libp2p.peerId.toString(),
			multiaddrs: libp2p.getMultiaddrs().map(ma => ma.toString())
		} : null);
		if (!info) return;
		navigator.clipboard.writeText(JSON.stringify(info, null, 2));
		showMessage('Peer info copied to clipboard!');
	}

	async function handleLinkDevice() {
		if (!linkInput.trim() || !deviceManager) return;
		isLinking = true;
		linkError = '';
		try {
			const payload = JSON.parse(linkInput.trim());
			const result = await deviceManager.linkToDevice(payload);
			if (result.type === 'granted') {
				showMessage('Device linked successfully!');
				linkInput = '';
				devices = await deviceManager.listDevices();
			} else {
				linkError = result.reason || 'Link request was rejected';
			}
		} catch (err) {
			linkError = `Failed to link: ${err.message}`;
		} finally {
			isLinking = false;
		}
	}

	async function handleImportDelegation() {
		if (!delegationText.trim()) {
			showMessage('Please paste a UCAN delegation', 'error');
			return;
		}
		isLoading = true;
		try {
			await handleConnectWithDelegation(delegationText.trim());
			delegationText = '';
		} catch (err) {
			showMessage(`Delegation import failed: ${err.message}`, 'error');
		} finally {
			isLoading = false;
		}
	}

	async function handleConnectWithDelegation(delegationStr) {
		const delegation = await parseDelegation(delegationStr);
		const principal = await identityService.getPrincipal();
		client = await createStorachaClient(principal, delegation);

		// Store delegation in registry DB (or localStorage fallback)
		const spaceDid = client.currentSpace()?.did?.() || '';
		await storeDelegation(delegationStr, registryDb, spaceDid);

		currentSpace = client.currentSpace();
		isLoggedIn = true;

		// Initialize bridge for backup/restore
		// For UCAN mode, pass the client directly
		bridge = new OrbitDBStorachaBridge({ ucanClient: client });
		if (currentSpace) {
			bridge.spaceDID = currentSpace.did();
		}

		// Set up progress listeners on bridge
		setupBridgeListeners();

		await loadSpaceUsage();
		showMessage('Connected to Storacha via UCAN delegation!');

		// Publish/update IPNS manifest
		await handlePublishManifest();
	}

	function setupBridgeListeners() {
		if (!bridge) return;
		bridge.on('uploadProgress', (progress) => {
			progressType = 'upload';
			progressCurrent = progress.current;
			progressTotal = progress.total;
			progressPercentage = progress.percentage;
			progressCurrentBlock = progress.currentBlock;
			progressError = progress.error;
			showProgress = true;
		});
		bridge.on('downloadProgress', (progress) => {
			progressType = 'download';
			progressCurrent = progress.current;
			progressTotal = progress.total;
			progressPercentage = progress.percentage;
			progressCurrentBlock = progress.currentBlock;
			progressError = progress.error;
			showProgress = true;
		});
	}

	async function handleLogout() {
		isLoggedIn = false;
		client = null;
		currentSpace = null;
		spaces = [];
		spaceUsage = null;
		signingMode = null;
		await clearStoredDelegation(registryDb);
		if (bridge) { bridge.removeAllListeners(); bridge = null; }
		resetProgress();
		showMessage('Logged out successfully');
	}

	async function loadSpaceUsage() {
		if (!client) return;
		try {
			spaceUsage = await getSpaceUsage(client);
		} catch (err) {
			console.warn('Failed to load space usage info:', err.message);
			spaceUsage = null;
		}
	}

	async function loadSpaces() {
		if (!client) return;
		isLoading = true;
		status = 'Loading spaces...';
		try {
			spaces = await listSpaces(client);
			await loadSpaceUsage();
		} catch (err) {
			showMessage(`Failed to load spaces: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
		}
	}

	async function handleBackup() {
		if (!bridge) {
			showMessage('Please log in first', 'error');
			return;
		}

		const hasDatabase = database && entryCount > 0;
		const hasRegistry = !!registryDb;

		if (!hasDatabase && !hasRegistry) {
			showMessage('No data to backup', 'error');
			return;
		}

		isLoading = true;
		resetProgress();
		status = 'Preparing backup...';

		try {
			// Backup user database if available
			if (hasDatabase) {
				const result = await bridge.backup(orbitdb, database.address);

				if (result.success) {
					showMessage(
						`Backup completed! ${result.blocksUploaded}/${result.blocksTotal} blocks uploaded`
					);
					onBackup(result);
				} else {
					showMessage(result.error, 'error');
					return;
				}
			}

			// Backup registry DB
			if (hasRegistry) {
				try {
					const regResult = await backupRegistryDb(bridge, orbitdb, registryDb);
					console.log('[ui] Registry DB backed up:', regResult);
					if (!hasDatabase) {
						showMessage('Registry backup completed!');
					}
				} catch (err) {
					console.warn('[ui] Registry backup failed:', err.message);
				}
			}

			await handlePublishManifest();
		} catch (err) {
			showMessage(`Backup failed: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
			resetProgress();
		}
	}

	async function restoreFromSpaceFallback() {
		if (!orbitdb) {
			showMessage('OrbitDB not initialized. Please wait for initialization to complete.', 'error');
			return;
		}

		isLoading = true;
		resetProgress();
		status = 'Preparing restore...';

		try {
			// Close existing database if provided
			if (database) {
				status = 'Closing existing database...';
				try {
					await database.close();
				} catch {
					// Continue even if close fails
				}
			}

			status = 'Starting restore...';

			if (!bridge) {
				throw new Error('Bridge not initialized. Please connect to Storacha first.');
			}

			const result = await bridge.restoreFromSpace(orbitdb, {
				timeout: 120000,
				preferredDatabaseName: databaseName,
				restartAfterRestore: true,
				verifyIntegrity: true
			});

			if (result.success) {
				showMessage(
					`Restore completed! ${result.entriesRecovered} entries recovered.`
				);
				onRestore(result.database);
			} else {
				showMessage(`Restore failed: ${result.error}`, 'error');
			}
		} catch (err) {
			showMessage(`Restore failed: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
			resetProgress();
		}
	}

	function formatRelativeTime(dateString) {
		if (!dateString) return 'Never';
		const date = new Date(dateString);
		const now = new Date();
		const diffInSeconds = Math.floor((now - date) / 1000);

		if (diffInSeconds < 60) return 'Just now';
		if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
		if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
		if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
		if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
		return `${Math.floor(diffInSeconds / 31536000)} years ago`;
	}

	function formatSpaceName(space) {
		return space.name === 'Unnamed Space' ? `Space ${space.did.slice(-8)}` : space.name;
	}

	onMount(async () => {
		// Try to reopen registry DB from stored address
		if (orbitdb) {
			const storedAddr = localStorage.getItem(REGISTRY_ADDRESS_KEY);
			if (storedAddr) {
				try {
					registryDb = await openDeviceRegistry(orbitdb, null, storedAddr);
					console.log('[ui] Reopened registry DB from stored address');
				} catch (err) {
					console.warn('[ui] Failed to reopen registry:', err.message);
				}
			}
		}

		// Check for stored signing mode (no biometric needed)
		const stored = identityService.getSigningMode();
		if (stored.mode) {
			signingMode = stored;
		}
		// Don't auto-connect — user must click "Authenticate" which may prompt biometric
	});
</script>

<div
	class="storacha-panel"
	style="max-height: 70vh; overflow-y: auto; border-radius: 0.75rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #FFE4AE, #EFE3F3); padding: 1rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
>
	<!-- Header -->
	<div
		style="margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(233, 19, 21, 0.2); padding-bottom: 0.75rem;"
	>
		<div style="display: flex; align-items: center; gap: 0.75rem;">
			<div style="border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.2); background-color: #ffffff; padding: 0.5rem; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);">
				<svg
					width="20"
					height="22"
					viewBox="0 0 154 172"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M110.999 41.5313H71.4081C70.2881 41.5313 69.334 42.4869 69.334 43.6087V154.359C69.334 159.461 69.1847 164.596 69.334 169.698C69.334 169.773 69.334 169.839 69.334 169.914C69.334 171.036 70.2881 171.992 71.4081 171.992H111.646C112.766 171.992 113.72 171.036 113.72 169.914V129.613L111.646 131.69H151.884C153.004 131.69 153.959 130.735 153.959 129.613V95.7513C153.959 91.6796 154.041 87.5996 153.942 83.5362C153.685 72.9996 149.512 62.8038 142.318 55.1091C135.125 47.4144 125.319 42.7029 114.907 41.7141C113.604 41.5894 112.302 41.5313 110.991 41.5313C108.319 41.523 108.319 45.6777 110.991 45.6861C120.772 45.7193 130.305 49.4171 137.457 56.1229C144.608 62.8287 149.022 71.9443 149.702 81.6416C149.993 85.813 149.802 90.0592 149.802 94.2306V124.677C149.802 126.231 149.694 127.826 149.802 129.38C149.802 129.455 149.802 129.53 149.802 129.604L151.876 127.527H111.638C110.518 127.527 109.564 128.483 109.564 129.604V169.906L111.638 167.829H71.3998L73.474 169.906V48.7689C73.474 47.1319 73.5818 45.4617 73.474 43.8247C73.474 43.7499 73.474 43.6834 73.474 43.6087L71.3998 45.6861H110.991C113.662 45.6861 113.662 41.5313 110.991 41.5313H110.999Z"
						fill="#E91315"
					/>
					<path
						d="M108.519 68.9694C108.452 62.9532 104.727 57.66 99.1103 55.5494C93.4935 53.4387 87.0886 55.2669 83.3718 59.779C79.5554 64.4157 78.9165 71.0966 82.0277 76.2901C85.1389 81.4836 91.2037 84.0762 97.1025 82.9544C103.723 81.6996 108.444 75.617 108.527 68.9694C108.56 66.2937 104.412 66.2937 104.379 68.9694C104.329 73.1325 101.749 77.0878 97.7579 78.4838C93.7673 79.8798 89.03 78.6749 86.3087 75.2265C83.5875 71.778 83.4879 67.2077 85.6865 63.6346C87.8851 60.0615 92.2076 58.1752 96.2811 59.0477C100.985 60.0532 104.32 64.1664 104.379 68.9777C104.412 71.6533 108.56 71.6533 108.527 68.9777L108.519 68.9694Z"
						fill="#E91315"
					/>
					<path
						d="M94.265 73.3237C96.666 73.3237 98.6124 71.3742 98.6124 68.9695C98.6124 66.5647 96.666 64.6152 94.265 64.6152C91.8641 64.6152 89.9177 66.5647 89.9177 68.9695C89.9177 71.3742 91.8641 73.3237 94.265 73.3237Z"
						fill="#E91315"
					/>
					<path
						d="M71.4081 36.8029H132.429C144.642 36.8029 150.64 28.5764 151.752 23.8981C152.863 19.2281 147.263 7.43685 133.624 22.1199C133.624 22.1199 141.754 6.32336 130.869 2.76686C119.984 -0.789637 107.473 10.1042 102.512 20.5577C102.512 20.5577 103.109 7.6529 91.8923 10.769C80.6754 13.8851 71.4081 36.7946 71.4081 36.7946V36.8029Z"
						fill="#E91315"
					/>
					<path
						d="M18.186 66.1195C17.879 66.0531 17.8707 65.6126 18.1694 65.5212C31.6927 61.4246 42.2376 70.7895 46.0457 76.6312C48.3189 80.1212 51.6956 83.3868 54.1182 85.5058C55.4042 86.6276 55.0889 88.7216 53.5292 89.4113C52.4589 89.8849 50.7498 90.9402 49.2316 91.846C46.3859 93.5495 42.4699 100.554 33.0948 101.884C26.1921 102.856 17.6716 98.7014 13.6561 96.4329C13.3408 96.2584 13.5399 95.793 13.8884 95.8761C19.8536 97.3137 24.2673 94.8291 22.4753 91.5302C21.1395 89.0706 17.5223 88.1482 12.2789 90.2339C7.61621 92.087 2.07414 86.0376 0.597357 84.2843C0.439724 84.1015 0.555875 83.8106 0.788177 83.7857C5.16044 83.3453 9.41656 78.8664 12.2291 74.1715C14.801 69.8755 20.5837 69.4849 22.4255 69.4683C22.6744 69.4683 22.8154 69.1858 22.6661 68.9863C22.0605 68.1886 20.6169 66.6513 18.186 66.1112V66.1195ZM30.1413 87.9571C29.7264 87.9322 29.4692 88.3975 29.7181 88.7299C30.7967 90.1342 33.5345 92.5855 38.7448 90.9818C45.8134 88.8047 46.1038 84.3175 40.9516 80.3455C36.4798 76.9054 29.2204 77.5618 24.8647 79.8968C24.4084 80.1461 24.5992 80.8441 25.1136 80.8026C26.8641 80.6696 30.133 80.8607 32.0827 82.2401C34.7126 84.0932 35.617 88.331 30.1413 87.9654V87.9571Z"
						fill="#E91315"
					/>
				</svg>
			</div>
			<div>
				<h3
					style="font-size: 1.125rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
				>
					Storacha
				</h3>
				<p style="font-size: 0.75rem; color: #555; font-family: 'DM Mono', monospace;">
					Keep it Spicy
				</p>
			</div>
		</div>

		<button
			class="storacha-toggle"
			onclick={() => (showStoracha = !showStoracha)}
			style="border-radius: 0.5rem; padding: 0.5rem; color: #E91315; transition: color 150ms, background-color 150ms; border: none; background: transparent; cursor: pointer;"
			title={showStoracha ? 'Collapse' : 'Expand'}
			aria-label={showStoracha ? 'Collapse Storacha panel' : 'Expand Storacha panel'}
		>
			<svg
				style="height: 1rem; width: 1rem; transition: transform 200ms; transform: {showStoracha ? 'rotate(180deg)' : 'rotate(0deg)'};"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
	</div>

	{#if showStoracha}
		<!-- OrbitDB Initialization Status -->
		{#if !isInitialized}
			<div
				style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(217, 169, 56, 0.4); background: linear-gradient(to right, #fff8e1, #fffde7, #fff3e0); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
			>
				<div style="display: flex; align-items: flex-start; gap: 0.75rem;">
					<div
						style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #FFC83F, #e67e22); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;"
					>
						<Loader2 style="height: 1rem; width: 1rem; color: #ffffff; animation: spin 1s linear infinite;" />
					</div>
					<div style="flex: 1; font-size: 0.875rem;">
						<div style="font-weight: 600; color: #78350f; font-family: 'Epilogue', sans-serif;">
							Database Initializing
						</div>
						<div style="margin-top: 0.25rem; color: rgba(120, 53, 15, 0.9); font-family: 'DM Sans', sans-serif;">
							OrbitDB is still setting up. You can login to Storacha now, but backup & restore will be available once initialization completes.
						</div>
						<div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
							<div style="height: 0.375rem; width: 6rem; border-radius: 9999px; background-color: #fde68a;">
								<div style="height: 100%; width: 75%; border-radius: 9999px; background: linear-gradient(to right, #FFC83F, #e67e22); animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;"></div>
							</div>
							<span style="font-size: 0.75rem; color: #92400e; font-family: 'DM Mono', monospace;">Please wait...</span>
						</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Status Messages -->
		{#if error}
			<div
				style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.4); background: linear-gradient(to right, #fef2f2, #fdf2f8, #fff1f2); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
			>
				<div style="display: flex; align-items: flex-start; gap: 0.75rem;">
					<div style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #E91315, #be123c); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;">
						<AlertCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
					</div>
					<div style="flex: 1;">
						<div style="font-weight: 600; color: #7f1d1d; font-family: 'Epilogue', sans-serif;">
							Error
						</div>
						<div style="margin-top: 0.25rem; font-size: 0.875rem; color: rgba(127, 29, 29, 0.9); font-family: 'DM Sans', sans-serif;">
							{error}
						</div>
					</div>
				</div>
			</div>
		{/if}

		{#if success}
			<div
				style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(16, 185, 129, 0.4); background: linear-gradient(to right, #ecfdf5, #f0fdf4, #f0fdfa); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
			>
				<div style="display: flex; align-items: flex-start; gap: 0.75rem;">
					<div style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #10b981, #14b8a6); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;">
						<CheckCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
					</div>
					<div style="flex: 1;">
						<div style="font-weight: 600; color: #064e3b; font-family: 'Epilogue', sans-serif;">
							Success
						</div>
						<div style="margin-top: 0.25rem; font-size: 0.875rem; color: rgba(6, 78, 59, 0.9); font-family: 'DM Sans', sans-serif;">
							{success}
						</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Progress Bar -->
		{#if showProgress}
			<div
				style="margin-bottom: 1rem; border-radius: 0.5rem; border: 1px solid rgba(233, 19, 21, 0.3); background: linear-gradient(to right, #FFF5E6, #FFF0F0, #FFF5E6); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);"
			>
				<div style="display: flex; align-items: flex-start; gap: 0.75rem;">
					<div style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background: linear-gradient(to bottom right, #E91315, #FFC83F); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;">
						<svg style="height: 1rem; width: 1rem; color: #ffffff; animation: spin 1s linear infinite;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
						</svg>
					</div>
					<div style="flex: 1;">
						<div style="margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between;">
							<span style="font-weight: 600; color: #7A1518; font-family: 'Epilogue', sans-serif;">
								{progressType === 'upload' ? 'Uploading' : 'Downloading'} Progress
							</span>
							<span style="font-size: 0.875rem; font-weight: 500; color: #E91315; font-family: 'DM Mono', monospace;">
								{progressPercentage}% ({progressCurrent}/{progressTotal})
							</span>
						</div>
						<div style="height: 0.75rem; width: 100%; border-radius: 9999px; background-color: #FFE4AE; box-shadow: inset 0 2px 4px 0 rgba(0,0,0,0.05);">
							<div
								style="height: 0.75rem; border-radius: 9999px; background: linear-gradient(to right, #E91315, #FFC83F, #E91315); box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05); transition: all 500ms ease-out; width: {progressPercentage}%"
							></div>
						</div>
						{#if progressCurrentBlock}
							<div style="margin-top: 0.5rem; font-size: 0.75rem; color: rgba(122, 21, 24, 0.8); font-family: 'DM Mono', monospace;">
								{progressType === 'upload' ? 'Current block:' : 'Current CID:'}
								<span style="font-weight: 500;">
									{progressType === 'upload'
										? progressCurrentBlock.hash?.slice(0, 16)
										: progressCurrentBlock.storachaCID?.slice(0, 16)}...
								</span>
							</div>
						{/if}
						{#if progressError}
							<div style="margin-top: 0.5rem; border-radius: 0.375rem; background-color: #fee2e2; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #b91c1c; font-family: 'DM Sans', sans-serif;">
								Error: {progressError.message}
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		{#if !isLoggedIn}
			<!-- Login Section -->
			<div style="display: flex; flex-direction: column; gap: 1rem;">
				<div style="text-align: center; font-size: 0.875rem; color: #374151; font-family: 'DM Sans', sans-serif;">
					Connect to <span style="font-weight: 700; color: #E91315;">Storacha</span> to backup your data to decentralized storage!
				</div>

				{#if !signingMode}
					<!-- Step 1: Authenticate with Passkey -->
					<div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem;">
						<div style="text-align: center; font-size: 0.75rem; color: #6b7280; font-family: 'DM Sans', sans-serif;">
							Step 1: Authenticate with your passkey to establish your identity
						</div>
						<button
							class="storacha-btn-primary"
							onclick={handleAuthenticate}
							disabled={isAuthenticating}
							style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.625rem 1.5rem; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; font-size: 0.875rem; opacity: {isAuthenticating ? '0.5' : '1'};"
						>
							{#if isAuthenticating}
								<Loader2 style="height: 1rem; width: 1rem; animation: spin 1s linear infinite;" />
								<span>Authenticating...</span>
							{:else}
								<svg style="height: 1rem; width: 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
								</svg>
								<span>Authenticate with Passkey</span>
							{/if}
						</button>

						<!-- Recover Identity -->
						<button
							onclick={handleRecover}
							disabled={isRecovering}
							style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: transparent; padding: 0.5rem 1.25rem; color: #E91315; border: 1px solid #E91315; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; font-size: 0.75rem; opacity: {isRecovering ? '0.5' : '1'}; transition: background-color 150ms;"
						>
							{#if isRecovering}
								<Loader2 style="height: 0.875rem; width: 0.875rem; animation: spin 1s linear infinite;" />
								<span>{recoveryStatus || 'Recovering...'}</span>
							{:else}
								<svg style="height: 0.875rem; width: 0.875rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
								</svg>
								<span>Recover Identity</span>
							{/if}
						</button>
					</div>
				{:else}
					<!-- Step 2: Authenticated — show DID info + delegation import -->
					<div style="display: flex; flex-direction: column; gap: 0.75rem;">
						<!-- Signing Mode Badge -->
						<div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; flex-wrap: wrap;">
							{#if signingMode.algorithm === 'Ed25519' && signingMode.mode === 'hardware'}
								<span style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #dcfce7; border: 1px solid #86efac; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #166534; font-family: 'DM Sans', sans-serif;">
									<svg style="height: 0.625rem; width: 0.625rem;" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>
									Hardware Ed25519
								</span>
							{:else if signingMode.algorithm === 'P-256' && signingMode.mode === 'hardware'}
								<span style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #BDE0FF; border: 1px solid #0176CE; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #0176CE; font-family: 'DM Sans', sans-serif;">
									<svg style="height: 0.625rem; width: 0.625rem;" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>
									Hardware P-256
								</span>
							{:else}
								<span style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #FFE4AE; border: 1px solid #FFC83F; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: #92400e; font-family: 'DM Sans', sans-serif;">
									<svg style="height: 0.625rem; width: 0.625rem;" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
									Worker Ed25519
								</span>
							{/if}
							{#if signingMode.secure}
								<span style="display: inline-flex; align-items: center; gap: 0.25rem; border-radius: 9999px; background-color: #dcfce7; border: 1px solid #86efac; padding: 0.25rem 0.5rem; font-size: 0.625rem; font-weight: 500; color: #166534; font-family: 'DM Mono', monospace;">
									Secure
								</span>
							{/if}
						</div>

						<!-- DID Display -->
						<div style="border-radius: 0.375rem; border: 1px solid rgba(233, 19, 21, 0.3); background: linear-gradient(to right, #ffffff, #EFE3F3); padding: 0.625rem 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);">
							<div style="font-size: 0.625rem; font-weight: 600; color: #6b7280; font-family: 'DM Sans', sans-serif; margin-bottom: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em;">
								Your DID
							</div>
							<div style="display: flex; align-items: center; gap: 0.5rem;">
								<code style="flex: 1; font-size: 0.75rem; color: #374151; font-family: 'DM Mono', monospace; word-break: break-all; line-height: 1.4;">
									{signingMode.did ? (signingMode.did.length > 40 ? signingMode.did.slice(0, 20) + '...' + signingMode.did.slice(-16) : signingMode.did) : 'N/A'}
								</code>
								<button
									class="storacha-btn-icon"
									onclick={() => {
										if (signingMode.did) {
											navigator.clipboard.writeText(signingMode.did);
											showMessage('DID copied to clipboard!');
										}
									}}
									style="border-radius: 0.25rem; padding: 0.25rem; color: #0176CE; transition: all 150ms; border: none; background: transparent; cursor: pointer; flex-shrink: 0;"
									title="Copy full DID"
									aria-label="Copy DID to clipboard"
								>
									<svg style="height: 0.875rem; width: 0.875rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
									</svg>
								</button>
							</div>
						</div>

						<!-- Delegation Import -->
						<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #EFE3F3); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);">
							<h4 style="margin-bottom: 0.5rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; font-size: 0.875rem;">
								Import UCAN Delegation
							</h4>
							<p style="margin-bottom: 0.75rem; font-size: 0.75rem; color: #6b7280; font-family: 'DM Sans', sans-serif; line-height: 1.4;">
								Paste the UCAN delegation string you received to connect to a Storacha space.
							</p>
							<div style="display: flex; flex-direction: column; gap: 0.75rem;">
								<textarea
									class="storacha-textarea"
									bind:value={delegationText}
									placeholder="Paste your UCAN delegation here (base64 encoded)..."
									rows="4"
									style="width: 100%; resize: none; border-radius: 0.375rem; border: 1px solid #E91315; background-color: #ffffff; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #111827; font-family: 'DM Mono', monospace; outline: none; box-sizing: border-box;"
								></textarea>
								<button
									class="storacha-btn-primary"
									onclick={handleImportDelegation}
									disabled={isLoading || !delegationText.trim()}
									style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.5rem 1rem; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 600; opacity: {isLoading || !delegationText.trim() ? '0.5' : '1'}; box-sizing: border-box;"
								>
									{#if isLoading}
										<Loader2 style="height: 1rem; width: 1rem; animation: spin 1s linear infinite;" />
										<span>Connecting...</span>
									{:else}
										<svg style="height: 1rem; width: 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
										</svg>
										<span>Connect</span>
									{/if}
								</button>
							</div>
						</div>
					</div>
				{/if}

				{#if signingMode}
				<!-- Tab Navigation (visible after authentication) -->
				<div style="border-radius: 0.5rem; background: rgba(233, 19, 21, 0.06); padding: 0.25rem; display: flex; gap: 0.25rem;">
					<button
						onclick={() => handleTabSwitch('storacha')}
						style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab === 'storacha' ? 'linear-gradient(135deg, #E91315, #FFC83F)' : 'transparent'}; color: {activeTab === 'storacha' ? '#fff' : '#6B7280'}; box-shadow: {activeTab === 'storacha' ? '0 2px 8px rgba(233, 19, 21, 0.3)' : 'none'};"
					>
						Storacha
					</button>
					<button
						onclick={() => handleTabSwitch('passkeys')}
						style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab === 'passkeys' ? 'linear-gradient(135deg, #E91315, #FFC83F)' : 'transparent'}; color: {activeTab === 'passkeys' ? '#fff' : '#6B7280'}; box-shadow: {activeTab === 'passkeys' ? '0 2px 8px rgba(233, 19, 21, 0.3)' : 'none'};"
					>
						P2P Passkeys
					</button>
				</div>

				{#if activeTab === 'passkeys'}
				<div style="display: flex; flex-direction: column; gap: 0.75rem;">
					<!-- Connection Status + Copy -->
					<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #ffffff, #FFE4AE); padding: 0.625rem 0.75rem;">
						<div style="display: flex; align-items: center; justify-content: space-between;">
							<div style="display: flex; align-items: center; gap: 0.5rem;">
								<div style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background: {libp2p ? '#10b981' : '#9ca3af'}; box-shadow: {libp2p ? '0 0 0 3px rgba(16, 185, 129, 0.2)' : 'none'}; animation: {libp2p ? 'pulse 2s infinite' : 'none'};"></div>
								<span style="font-size: 0.75rem; font-weight: 600; color: {libp2p ? '#064e3b' : '#6B7280'}; font-family: 'Epilogue', sans-serif;">
									{libp2p ? 'P2P Connected' : 'P2P Offline'}
								</span>
							</div>
							<div style="display: flex; align-items: center; gap: 0.375rem;">
								{#if libp2p}
									<code style="font-size: 0.6rem; color: #E91315; font-family: 'DM Mono', monospace; background: rgba(233, 19, 21, 0.06); padding: 0.125rem 0.375rem; border-radius: 0.25rem;">
										{libp2p.peerId.toString().slice(0, 8)}...{libp2p.peerId.toString().slice(-4)}
									</code>
									<button onclick={handleCopyPeerInfo} title="Copy peer info to clipboard" style="display: flex; align-items: center; justify-content: center; height: 1.25rem; width: 1.25rem; border-radius: 0.25rem; border: none; background: transparent; cursor: pointer; color: #E91315; padding: 0; transition: all 150ms;">
										<svg style="height: 0.7rem; width: 0.7rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
										</svg>
									</button>
								{/if}
							</div>
						</div>
						{#if ipnsNameString}
							<div style="font-size: 0.7rem; color: #6b7280; font-family: 'DM Mono', monospace; margin-top: 0.25rem;">
								IPNS: {ipnsNameString.slice(0, 20)}...
							</div>
						{/if}
					</div>

					<!-- Linked Devices List -->
					<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 0.75rem;">
						<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
							<div style="font-size: 0.65rem; font-weight: 700; color: #E91315; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'DM Sans', sans-serif;">
								Linked Devices
							</div>
							<div style="display: flex; align-items: center; gap: 0.25rem; background: #FFC83F; padding: 0.125rem 0.5rem; border-radius: 9999px;">
								<span style="font-size: 0.7rem; font-weight: 700; color: #111827; font-family: 'DM Mono', monospace;">{devices.length}</span>
							</div>
						</div>
						{#if devices.length === 0}
							<div style="text-align: center; padding: 1rem; font-size: 0.8rem; color: #9ca3af; font-family: 'DM Sans', sans-serif;">
								No devices linked yet
							</div>
						{/if}
					</div>
				</div>
				{/if}
				{/if}
			</div>
		{:else}
			<!-- Logged In Section -->
			<div style="display: flex; flex-direction: column; gap: 1rem;">
				<!-- Account Info -->
				<div style="display: flex; align-items: center; justify-content: space-between; border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #BDE0FF, #FFE4AE); padding: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);">
					<div style="display: flex; align-items: center; gap: 0.75rem;">
						<div style="display: flex; height: 2rem; width: 2rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); flex-shrink: 0;">
							<CheckCircle style="height: 1rem; width: 1rem; color: #ffffff;" />
						</div>
						<div>
							<div style="font-size: 0.875rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif;">
								Connected to Storacha
							</div>
							{#if currentSpace}
								<div style="font-size: 0.75rem; color: #0176CE; font-family: 'DM Mono', monospace;">
									Space: {formatSpaceName(currentSpace)}
								</div>
							{/if}
						</div>
					</div>

					<button
						class="storacha-btn-icon"
						onclick={handleLogout}
						style="display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.75rem; font-size: 0.875rem; color: #E91315; transition: color 150ms, background-color 150ms; border: none; background: transparent; cursor: pointer; font-family: 'DM Sans', sans-serif;"
					>
						<LogOut style="height: 0.75rem; width: 0.75rem;" />
						<span>Logout</span>
					</button>
				</div>

				<!-- Tab Navigation -->
				<div style="border-radius: 0.5rem; background: rgba(233, 19, 21, 0.06); padding: 0.25rem; display: flex; gap: 0.25rem;">
					<button
						onclick={() => handleTabSwitch('storacha')}
						style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab === 'storacha' ? 'linear-gradient(135deg, #E91315, #FFC83F)' : 'transparent'}; color: {activeTab === 'storacha' ? '#fff' : '#6B7280'}; box-shadow: {activeTab === 'storacha' ? '0 2px 8px rgba(233, 19, 21, 0.3)' : 'none'};"
					>
						Storacha
					</button>
					<button
						onclick={() => handleTabSwitch('passkeys')}
						style="flex: 1; padding: 0.5rem 1rem; border-radius: 0.375rem; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-size: 0.8rem; font-weight: 600; transition: all 200ms; background: {activeTab === 'passkeys' ? 'linear-gradient(135deg, #E91315, #FFC83F)' : 'transparent'}; color: {activeTab === 'passkeys' ? '#fff' : '#6B7280'}; box-shadow: {activeTab === 'passkeys' ? '0 2px 8px rgba(233, 19, 21, 0.3)' : 'none'};"
					>
						P2P Passkeys
					</button>
				</div>

				{#if activeTab === 'storacha'}
				<!-- Action Buttons -->
				<div style="display: flex; flex-direction: column; gap: 0.75rem;">
					<button
						class="storacha-btn-backup"
						onclick={handleBackup}
						disabled={isLoading || (!registryDb && entryCount === 0)}
						style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #FFC83F; padding: 0.5rem 1rem; font-weight: 700; color: #111827; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; opacity: {isLoading || (!registryDb && entryCount === 0) ? '0.5' : '1'}; box-sizing: border-box;"
					>
						<Upload style="height: 1rem; width: 1rem;" />
						<span>Backup to Storacha</span>
					</button>

					<button
						class="storacha-btn-restore"
						onclick={restoreFromSpaceFallback}
						disabled={isLoading || !isInitialized}
						style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #0176CE; padding: 0.5rem 1rem; font-weight: 700; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); transition: color 150ms, background-color 150ms; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; opacity: {isLoading || !isInitialized ? '0.5' : '1'}; box-sizing: border-box;"
						title="Restore database from Storacha backup"
					>
						<Download style="height: 1rem; width: 1rem;" />
						<span>Restore from Storacha</span>
					</button>
				</div>

				<!-- Space Usage Information -->
				<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);">
					<div style="margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
						<h4 style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; margin: 0;">
							<svg style="height: 1rem; width: 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
							</svg>
							<span>Storage Analytics</span>
						</h4>
						<div style="display: flex; align-items: center; gap: 0.25rem;">
							<button
								class="storacha-btn-icon"
								onclick={loadSpaceUsage}
								disabled={isLoading}
								style="border-radius: 0.375rem; padding: 0.5rem; color: #E91315; transition: all 300ms; border: none; background: transparent; cursor: pointer; opacity: {isLoading ? '0.5' : '1'};"
								title="Refresh space usage"
								aria-label="Refresh space usage"
							>
								<svg style="height: 1rem; width: 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
								</svg>
							</button>
							{#if spaceUsage && spaceUsage.totalFiles <= 50 && !spaceUsage.analyzed}
								<button
									class="storacha-btn-icon"
									onclick={async () => {
										spaceUsage = await getSpaceUsage(client, true);
									}}
									disabled={isLoading}
									style="border-radius: 0.375rem; padding: 0.5rem; color: #0176CE; transition: all 300ms; border: none; background: transparent; cursor: pointer; opacity: {isLoading ? '0.5' : '1'};"
									title="Analyze file types"
									aria-label="Analyze file types"
								>
									<svg style="height: 1rem; width: 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
									</svg>
								</button>
							{/if}
						</div>
					</div>

					{#if spaceUsage}
						<div style="margin-bottom: 1rem; border-radius: 0.25rem; border: 1px solid #E91315; background: linear-gradient(to right, #EFE3F3, #ffffff); padding: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);">
							<div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.875rem;">
								<div style="display: flex; align-items: center; gap: 0.5rem;">
									<div style="display: flex; height: 1.5rem; width: 1.5rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);">
										<span style="font-size: 0.75rem; font-weight: 700; color: #ffffff; font-family: 'DM Mono', monospace;">{spaceUsage.totalFiles}</span>
									</div>
									<span style="font-weight: 500; color: #1f2937; font-family: 'DM Sans', sans-serif;">
										file{spaceUsage.totalFiles !== 1 ? 's' : ''} stored
									</span>
								</div>
								{#if spaceUsage.lastUploadDate}
									<div style="color: #0176CE; font-family: 'DM Mono', monospace; font-size: 0.75rem;">
										Last upload: {formatRelativeTime(spaceUsage.lastUploadDate)}
									</div>
								{/if}
							</div>

							{#if spaceUsage.totalFiles > 0}
								<div style="margin-top: 0.5rem; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; font-size: 0.75rem;">
									{#if spaceUsage.backupFiles > 0}
										<div style="display: flex; align-items: center; gap: 0.25rem;">
											<div style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #FFC83F;"></div>
											<span style="color: #374151; font-family: 'DM Sans', sans-serif;">
												{spaceUsage.backupFiles} backup{spaceUsage.backupFiles !== 1 ? 's' : ''}
											</span>
										</div>
									{/if}
									{#if spaceUsage.blockFiles > 0}
										<div style="display: flex; align-items: center; gap: 0.25rem;">
											<div style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #0176CE;"></div>
											<span style="color: #374151; font-family: 'DM Sans', sans-serif;">
												{spaceUsage.blockFiles} data block{spaceUsage.blockFiles !== 1 ? 's' : ''}
											</span>
										</div>
									{/if}
									{#if spaceUsage.otherFiles > 0}
										<div style="display: flex; align-items: center; gap: 0.25rem;">
											<div style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background-color: #E91315;"></div>
											<span style="color: #374151; font-family: 'DM Sans', sans-serif;">
												{spaceUsage.otherFiles} other
											</span>
										</div>
									{/if}
								</div>

								<div style="margin-top: 0.5rem; font-size: 0.75rem; color: #4b5563; font-family: 'DM Sans', sans-serif;">
									{#if spaceUsage.oldestUploadDate && spaceUsage.oldestUploadDate !== spaceUsage.lastUploadDate}
										<div style="color: #0176CE; font-family: 'DM Mono', monospace;">
											Oldest upload: {formatRelativeTime(spaceUsage.oldestUploadDate)}
										</div>
									{/if}
									<em style="color: #6b7280;">Note: Each backup creates many data blocks</em>
								</div>
							{/if}
						</div>
					{:else if spaceUsage === null && isLoggedIn}
						<div style="margin-bottom: 1rem; border-radius: 0.25rem; border: 1px solid #E91315; background: linear-gradient(to right, #EFE3F3, #FFE4AE); padding: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);">
							<div style="display: flex; align-items: center; gap: 0.5rem;">
								<div style="display: flex; height: 1.25rem; width: 1.25rem; align-items: center; justify-content: center; border-radius: 9999px; background-color: #E91315; flex-shrink: 0;">
									<svg style="height: 0.75rem; width: 0.75rem; color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
									</svg>
								</div>
								<div style="font-size: 0.875rem; font-weight: 500; color: #E91315; font-family: 'DM Sans', sans-serif;">
									Space usage information unavailable
								</div>
							</div>
						</div>
					{/if}
				</div>
				{/if}

				{#if activeTab === 'passkeys'}
				<div style="display: flex; flex-direction: column; gap: 0.75rem;">
					<!-- Connection Status + Copy -->
					<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to right, #ffffff, #FFE4AE); padding: 0.625rem 0.75rem;">
						<div style="display: flex; align-items: center; justify-content: space-between;">
							<div style="display: flex; align-items: center; gap: 0.5rem;">
								<div style="height: 0.5rem; width: 0.5rem; border-radius: 9999px; background: {libp2p ? '#10b981' : '#9ca3af'}; box-shadow: {libp2p ? '0 0 0 3px rgba(16, 185, 129, 0.2)' : 'none'}; animation: {libp2p ? 'pulse 2s infinite' : 'none'};"></div>
								<span style="font-size: 0.75rem; font-weight: 600; color: {libp2p ? '#064e3b' : '#6B7280'}; font-family: 'Epilogue', sans-serif;">
									{libp2p ? 'P2P Connected' : 'P2P Offline'}
								</span>
							</div>
							<div style="display: flex; align-items: center; gap: 0.375rem;">
								{#if libp2p}
									<code style="font-size: 0.6rem; color: #E91315; font-family: 'DM Mono', monospace; background: rgba(233, 19, 21, 0.06); padding: 0.125rem 0.375rem; border-radius: 0.25rem;">
										{libp2p.peerId.toString().slice(0, 8)}...{libp2p.peerId.toString().slice(-4)}
									</code>
									<button onclick={handleCopyPeerInfo} title="Copy peer info to clipboard" style="display: flex; align-items: center; justify-content: center; height: 1.25rem; width: 1.25rem; border-radius: 0.25rem; border: none; background: transparent; cursor: pointer; color: #E91315; padding: 0; transition: all 150ms;">
										<svg style="height: 0.7rem; width: 0.7rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
										</svg>
									</button>
								{/if}
							</div>
						</div>
						{#if ipnsNameString}
							<div style="font-size: 0.7rem; color: #6b7280; font-family: 'DM Mono', monospace; margin-top: 0.25rem;">
								IPNS: {ipnsNameString.slice(0, 20)}...
							</div>
						{/if}
					</div>

					{#if !libp2p}
						<div style="border-radius: 0.375rem; border: 1px dashed #E91315; background: rgba(233, 19, 21, 0.03); padding: 1.25rem; text-align: center;">
							<div style="font-size: 0.8rem; font-weight: 700; color: #E91315; font-family: 'Epilogue', sans-serif; margin-bottom: 0.25rem;">
								P2P Networking Not Available
							</div>
							<div style="font-size: 0.75rem; color: #6B7280; font-family: 'DM Sans', sans-serif; line-height: 1.4;">
								Provide a libp2p instance to enable device linking and peer-to-peer sync.
							</div>
						</div>
					{:else}
						<!-- Link Device -->
						<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 0.75rem;">
							<div style="font-size: 0.65rem; font-weight: 700; color: #E91315; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'DM Sans', sans-serif; margin-bottom: 0.5rem;">
								Link Another Device
							</div>
							<div style="display: flex; flex-direction: column; gap: 0.5rem;">
								<textarea
									class="storacha-textarea"
									bind:value={linkInput}
									placeholder="Paste peer info JSON from another device..."
									rows="3"
									style="width: 100%; resize: none; border-radius: 0.375rem; border: 1px solid #E91315; background: #ffffff; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #111827; font-family: 'DM Mono', monospace; outline: none; box-sizing: border-box;"
								></textarea>
								<button
									onclick={handleLinkDevice}
									disabled={isLinking || !linkInput.trim()}
									style="display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 0.375rem; background-color: #E91315; padding: 0.5rem 1rem; color: #ffffff; border: none; cursor: pointer; font-family: 'Epilogue', sans-serif; font-weight: 700; font-size: 0.8rem; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1); opacity: {isLinking || !linkInput.trim() ? '0.5' : '1'}; box-sizing: border-box;"
								>
									{#if isLinking}
										<Loader2 style="height: 0.875rem; width: 0.875rem; animation: spin 1s linear infinite;" />
										Linking...
									{:else}
										<svg style="height: 0.875rem; width: 0.875rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
										</svg>
										Link Device
									{/if}
								</button>
							</div>
							{#if linkError}
								<div style="margin-top: 0.5rem; font-size: 0.75rem; color: #b91c1c; font-family: 'DM Sans', sans-serif;">{linkError}</div>
							{/if}
						</div>
					{/if}

					<!-- Linked Devices List -->
					<div style="border-radius: 0.375rem; border: 1px solid #E91315; background: linear-gradient(to bottom right, #ffffff, #FFE4AE); padding: 0.75rem;">
						<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
							<div style="font-size: 0.65rem; font-weight: 700; color: #E91315; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'DM Sans', sans-serif;">
								Linked Devices
							</div>
							<div style="display: flex; align-items: center; gap: 0.25rem; background: #FFC83F; padding: 0.125rem 0.5rem; border-radius: 9999px;">
								<span style="font-size: 0.7rem; font-weight: 700; color: #111827; font-family: 'DM Mono', monospace;">{devices.length}</span>
							</div>
						</div>

						{#if devices.length === 0}
							<div style="text-align: center; padding: 1rem; font-size: 0.8rem; color: #9ca3af; font-family: 'DM Sans', sans-serif;">
								No devices linked yet
							</div>
						{:else}
							<div style="display: flex; flex-direction: column; gap: 0.375rem;">
								{#each devices as device}
									<div style="display: flex; align-items: center; gap: 0.625rem; padding: 0.5rem; border-radius: 0.375rem; background: rgba(255, 255, 255, 0.7); border-left: 3px solid {device.status === 'active' ? '#10b981' : '#E91315'};">
										<div style="font-size: 1rem; flex-shrink: 0;">
											{device.device_label === 'Mac' ? '\uD83D\uDCBB' : device.device_label === 'Windows PC' ? '\uD83D\uDDA5\uFE0F' : device.device_label === 'Linux' ? '\uD83D\uDC27' : '\uD83D\uDCF1'}
										</div>
										<div style="flex: 1; min-width: 0;">
											<div style="font-size: 0.8rem; font-weight: 600; color: #1f2937; font-family: 'DM Sans', sans-serif;">
												{device.device_label || 'Unknown Device'}
											</div>
											<code style="font-size: 0.625rem; color: #6B7280; font-family: 'DM Mono', monospace;">
												{device.ed25519_did ? device.ed25519_did.slice(0, 16) + '...' + device.ed25519_did.slice(-8) : 'N/A'}
											</code>
										</div>
										<span style="font-size: 0.6rem; font-weight: 600; padding: 0.125rem 0.375rem; border-radius: 9999px; flex-shrink: 0; background: {device.status === 'active' ? '#dcfce7' : '#fee2e2'}; color: {device.status === 'active' ? '#166534' : '#991b1b'}; font-family: 'DM Sans', sans-serif;">
											{device.status}
										</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}

	.storacha-panel::-webkit-scrollbar {
		width: 4px;
	}
	.storacha-panel::-webkit-scrollbar-track {
		background: rgba(0, 0, 0, 0.1);
		border-radius: 2px;
	}
	.storacha-panel::-webkit-scrollbar-thumb {
		background: rgba(0, 0, 0, 0.3);
		border-radius: 2px;
	}
	.storacha-panel::-webkit-scrollbar-thumb:hover {
		background: rgba(0, 0, 0, 0.4);
	}

	.storacha-btn-primary:hover:not(:disabled) {
		background-color: #b91c1c;
	}
	.storacha-btn-backup:hover:not(:disabled) {
		background-color: #eab308;
	}
	.storacha-btn-restore:hover:not(:disabled) {
		background-color: #1d4ed8;
	}
	.storacha-btn-cancel:hover {
		background-color: #9ca3af;
	}
	.storacha-btn-icon:hover:not(:disabled) {
		background-color: rgba(233, 19, 21, 0.1);
	}
	.storacha-toggle:hover {
		background-color: rgba(233, 19, 21, 0.08);
	}
	.storacha-textarea:focus {
		border-color: transparent;
		box-shadow: 0 0 0 2px #E91315;
	}
</style>
