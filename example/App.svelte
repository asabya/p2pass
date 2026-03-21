<script>
	import { onMount } from 'svelte';
	import { StorachaFab, setupP2PStack, createLibp2pInstance, cleanupP2PStack } from 'p2p-passkeys';
	import { loadWebAuthnCredentialSafe } from '@le-space/orbitdb-identity-provider-webauthn-did/standalone';

	let orbitdb = $state(null);
	let libp2p = $state(null);
	let database = $state(null);
	let isInitialized = $state(true);
	let entryCount = $state(0);
	let p2pStack = $state(null);

	let logs = $state([]);
	let logContainer = $state(null);

	const MAX_LOGS = 500;

	function addLog(level, args) {
		const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
		const parts = args.map(arg => {
			if (arg === null) return 'null';
			if (arg === undefined) return 'undefined';
			if (typeof arg === 'object') {
				try { return JSON.stringify(arg, null, 2); }
				catch { return String(arg); }
			}
			return String(arg);
		});

		logs = [...logs.slice(-(MAX_LOGS - 1)), { id: Date.now() + Math.random(), timestamp, message: parts.join(' ') }];

		if (logContainer) {
			requestAnimationFrame(() => {
				logContainer.scrollTop = logContainer.scrollHeight;
			});
		}
	}

	async function initP2P() {
		try {
			const credential = loadWebAuthnCredentialSafe();
			if (credential && !p2pStack) {
				// Full P2P stack with OrbitDB (credential available)
				if (libp2p && !orbitdb) { await libp2p.stop(); libp2p = null; }
				console.log('[app] Starting full P2P stack...');
				p2pStack = await setupP2PStack(credential);
				orbitdb = p2pStack.orbitdb;
				libp2p = p2pStack.libp2p;
				console.log('[app] Full P2P stack ready!');
				return;
			}
			if (!libp2p) {
				// libp2p only — no credential yet, but P2P tab can show connected
				console.log('[app] No credential yet, starting libp2p only...');
				libp2p = await createLibp2pInstance();
				console.log('[app] libp2p started:', libp2p.peerId.toString());
			}
		} catch (err) {
			console.error('[app] P2P init failed:', err.message);
		}
	}

	async function handleAuthenticate(signingMode) {
		console.log('[app] User authenticated:', signingMode.did);
		await initP2P();
	}

	onMount(() => {
		const orig = {
			log: console.log,
			warn: console.warn,
			error: console.error,
			debug: console.debug,
			info: console.info
		};

		console.log = (...args) => { orig.log(...args); addLog('log', args); };
		console.warn = (...args) => { orig.warn(...args); addLog('warn', args); };
		console.error = (...args) => { orig.error(...args); addLog('error', args); };
		console.debug = (...args) => { orig.debug(...args); addLog('debug', args); };
		console.info = (...args) => { orig.info(...args); addLog('info', args); };

		const onError = (event) => addLog('error', [`Uncaught: ${event.message} at ${event.filename}:${event.lineno}`]);
		const onUnhandled = (event) => addLog('error', [`Unhandled rejection: ${event.reason}`]);
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onUnhandled);

		// Initialize P2P stack
		initP2P();

		return () => {
			Object.assign(console, orig);
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onUnhandled);
			if (p2pStack) cleanupP2PStack(p2pStack);
		else if (libp2p) libp2p.stop();
		};
	});

	function handleRestore(restoredDb) {
		console.log('Database restored:', restoredDb);
		database = restoredDb;
	}

	function handleBackup(result) {
		console.log('Backup completed:', result);
	}
</script>

<div style="margin: 0; padding: 0; height: 100vh; background: #0f1117; color: #d4d4d8; font-family: 'JetBrains Mono', 'Fira Code', monospace; display: flex; flex-direction: column;">
	<!-- Header -->
	<div style="padding: 0.75rem 1rem; border-bottom: 1px solid #27272a; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;">
		<span style="font-size: 0.8rem; color: #71717a;">p2p-passkeys / logs</span>
		<button
			onclick={() => { logs = []; }}
			style="font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 4px; border: 1px solid #3f3f46; background: transparent; color: #71717a; cursor: pointer;"
		>
			Clear
		</button>
	</div>

	<!-- Logs -->
	<div
		bind:this={logContainer}
		style="flex: 1; overflow-y: auto; font-size: 0.75rem; line-height: 1.7; padding: 0;"
	>
		{#if logs.length === 0}
			<div style="padding: 3rem; text-align: center; color: #3f3f46;">
				Waiting for logs... Click the Storacha button to get started.
			</div>
		{/if}

		{#each logs as log (log.id)}
			<div style="padding: 1px 1rem; border-bottom: 1px solid #1a1a1f;">
				<span style="color: #3f3f46; margin-right: 0.5rem;">{log.timestamp}</span>
				<span>{log.message}</span>
			</div>
		{/each}
	</div>
</div>

<!-- Floating FAB -->
<StorachaFab
	{orbitdb}
	{database}
	{isInitialized}
	{entryCount}
	databaseName="my-database"
	onRestore={handleRestore}
	onBackup={handleBackup}
	onAuthenticate={handleAuthenticate}
	{libp2p}
	preferWorkerMode={true}
/>
