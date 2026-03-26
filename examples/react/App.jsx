import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StorachaFab } from 'p2p-passkeys/react';
import { setupP2PStack, createLibp2pInstance, cleanupP2PStack } from 'p2p-passkeys';

const MAX_LOGS = 500;

export default function App() {
	const [orbitdb, setOrbitdb] = useState(null);
	const [libp2p, setLibp2p] = useState(null);
	const [database, setDatabase] = useState(null);
	const [isInitialized] = useState(true);
	const [entryCount] = useState(0);
	const [logs, setLogs] = useState([]);
	const logContainerRef = useRef(null);
	const p2pStackRef = useRef(null);
	const libp2pRef = useRef(null);

	// Keep refs in sync with state for use in callbacks
	useEffect(() => { libp2pRef.current = libp2p; }, [libp2p]);

	const addLog = useCallback((level, args) => {
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

		setLogs(prev => [
			...prev.slice(-(MAX_LOGS - 1)),
			{ id: Date.now() + Math.random(), timestamp, message: parts.join(' ') }
		]);
	}, []);

	// Auto-scroll logs
	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [logs]);

	// Console interception + P2P init
	useEffect(() => {
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

		// Initialize libp2p
		(async () => {
			try {
				console.log('[app] Starting libp2p only...');
				const lp = await createLibp2pInstance();
				setLibp2p(lp);
				libp2pRef.current = lp;
				console.log('[app] libp2p started:', lp.peerId.toString());
			} catch (err) {
				console.error('[app] P2P init failed:', err.message);
			}
		})();

		return () => {
			Object.assign(console, orig);
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onUnhandled);
			if (p2pStackRef.current) cleanupP2PStack(p2pStackRef.current);
			else if (libp2pRef.current) libp2pRef.current.stop();
		};
	}, [addLog]);

	const handleAuthenticate = useCallback(async (signingMode) => {
		console.log('[app] User authenticated:', signingMode?.did ?? '(default identity)');
		if (!p2pStackRef.current) {
			console.log('[app] Starting full P2P stack after auth...');
			const stack = await setupP2PStack(null, { libp2p: libp2pRef.current || undefined });
			p2pStackRef.current = stack;
			setOrbitdb(stack.orbitdb);
			setLibp2p(stack.libp2p);
			console.log('[app] Full P2P stack ready!');
		}
	}, []);

	const handleRestore = useCallback((restoredDb) => {
		console.log('Database restored:', restoredDb);
		setDatabase(restoredDb);
	}, []);

	const handleBackup = useCallback((result) => {
		console.log('Backup completed:', result);
	}, []);

	return (
		<>
			<div style={{
				margin: 0, padding: 0, height: '100vh',
				background: '#0f1117', color: '#d4d4d8',
				fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
				display: 'flex', flexDirection: 'column'
			}}>
				{/* Header */}
				<div style={{
					padding: '0.75rem 1rem',
					borderBottom: '1px solid #27272a',
					display: 'flex', alignItems: 'center', justifyContent: 'space-between',
					flexShrink: 0
				}}>
					<span style={{ fontSize: '0.8rem', color: '#71717a' }}>p2p-passkeys / react / logs</span>
					<button
						onClick={() => setLogs([])}
						style={{
							fontSize: '0.7rem', padding: '0.2rem 0.6rem',
							borderRadius: '4px', border: '1px solid #3f3f46',
							background: 'transparent', color: '#71717a', cursor: 'pointer'
						}}
					>
						Clear
					</button>
				</div>

				{/* Logs */}
				<div
					ref={logContainerRef}
					style={{
						flex: 1, overflowY: 'auto',
						fontSize: '0.75rem', lineHeight: 1.7, padding: 0
					}}
				>
					{logs.length === 0 && (
						<div style={{ padding: '3rem', textAlign: 'center', color: '#3f3f46' }}>
							Waiting for logs... Click the Storacha button to get started.
						</div>
					)}
					{logs.map(log => (
						<div key={log.id} style={{ padding: '1px 1rem', borderBottom: '1px solid #1a1a1f' }}>
							<span style={{ color: '#3f3f46', marginRight: '0.5rem' }}>{log.timestamp}</span>
							<span>{log.message}</span>
						</div>
					))}
				</div>
			</div>

			{/* Floating FAB */}
			<StorachaFab
				orbitdb={orbitdb}
				database={database}
				isInitialized={isInitialized}
				entryCount={entryCount}
				databaseName="my-database"
				onRestore={handleRestore}
				onBackup={handleBackup}
				onAuthenticate={handleAuthenticate}
				libp2p={libp2p}
				preferWorkerMode={true}
			/>
		</>
	);
}
