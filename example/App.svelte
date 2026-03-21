<script>
	import { onMount } from 'svelte';
	import { StorachaFab } from '../src/lib';

	let orbitdb = $state(null);
	let database = $state(null);
	let isInitialized = $state(true);
	let entryCount = $state(0);

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

		return () => {
			Object.assign(console, orig);
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onUnhandled);
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
/>
