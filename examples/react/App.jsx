import React, { useEffect, useRef } from 'react';
import { StorachaFab } from 'p2p-passkeys/react';
import { setupP2PStack, createLibp2pInstance, cleanupP2PStack } from 'p2p-passkeys';

export default function App() {
	const fabRef = useRef(null);
	const p2pStackRef = useRef(null);
	const libp2pRef = useRef(null);

	useEffect(() => {
		(async () => {
			try {
				const lp = await createLibp2pInstance();
				libp2pRef.current = lp;
				fabRef.current?.setLibp2p(lp);
			} catch (err) {
				console.error('[app] P2P init failed:', err.message);
			}
		})();

		return () => {
			if (p2pStackRef.current) cleanupP2PStack(p2pStackRef.current);
			else if (libp2pRef.current) libp2pRef.current.stop();
		};
	}, []);

	const handleRestore = (restoredDb) => {
		fabRef.current?.setDatabase(restoredDb);
	};

	const handleAuthenticate = async () => {
		if (!p2pStackRef.current) {
			const stack = await setupP2PStack(null, { libp2p: libp2pRef.current || undefined });
			p2pStackRef.current = stack;
			libp2pRef.current = stack.libp2p;
			fabRef.current?.updateServices({
				orbitdb: stack.orbitdb,
				libp2p: stack.libp2p
			});
		}
	};

	return (
		<>
			<div style={{ margin: 0, minHeight: '100vh', background: '#0f1117' }} />
			<StorachaFab
				ref={fabRef}
				isInitialized={true}
				entryCount={0}
				databaseName="my-database"
				onRestore={handleRestore}
				onBackup={() => {}}
				onAuthenticate={handleAuthenticate}
				preferWorkerMode={true}
			/>
		</>
	);
}
