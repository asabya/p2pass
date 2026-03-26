import { useRef, useEffect } from 'react';
import { createFab } from './bridge.svelte.js';

export function StorachaFab({
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
}) {
	const containerRef = useRef(null);
	const bridgeRef = useRef(null);

	useEffect(() => {
		bridgeRef.current = createFab(containerRef.current, {
			orbitdb, database, isInitialized, entryCount, databaseName,
			onRestore, onBackup, onAuthenticate, libp2p, preferWorkerMode
		});
		return () => bridgeRef.current?.destroy();
	}, []);

	useEffect(() => {
		bridgeRef.current?.update({
			orbitdb, database, isInitialized, entryCount, databaseName,
			onRestore, onBackup, onAuthenticate, libp2p, preferWorkerMode
		});
	}, [orbitdb, database, isInitialized, entryCount, databaseName,
		onRestore, onBackup, onAuthenticate, libp2p, preferWorkerMode]);

	return <div ref={containerRef} />;
}
