/**
 * React host for the Svelte `StorachaFab` — floating passkey / Storacha UI.
 *
 * Prefer the Svelte component when possible; this wrapper exists for React apps.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createFab } from './bridge.svelte.js';

export const P2Pass = forwardRef(function P2Pass(
  {
    isInitialized = false,
    entryCount = 0,
    databaseName = 'restored-db',
    onRestore = () => {},
    onBackup = () => {},
    onAuthenticate = () => {},
    preferWorkerMode = false,
  },
  ref
) {
  const containerRef = useRef(null);
  const bridgeRef = useRef(null);
  const servicePropsRef = useRef({
    orbitdb: null,
    database: null,
    libp2p: null,
  });

  useEffect(() => {
    bridgeRef.current = createFab(containerRef.current, {
      ...servicePropsRef.current,
      isInitialized,
      entryCount,
      databaseName,
      onRestore,
      onBackup,
      onAuthenticate,
      preferWorkerMode,
    });
    return () => bridgeRef.current?.destroy();
  }, []);

  useEffect(() => {
    bridgeRef.current?.update({
      isInitialized,
      entryCount,
      databaseName,
      onRestore,
      onBackup,
      onAuthenticate,
      preferWorkerMode,
    });
  }, [
    isInitialized,
    entryCount,
    databaseName,
    onRestore,
    onBackup,
    onAuthenticate,
    preferWorkerMode,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      setOrbitdb(orbitdb) {
        servicePropsRef.current.orbitdb = orbitdb;
        bridgeRef.current?.update({ orbitdb });
      },
      setDatabase(database) {
        servicePropsRef.current.database = database;
        bridgeRef.current?.update({ database });
      },
      setLibp2p(libp2p) {
        servicePropsRef.current.libp2p = libp2p;
        bridgeRef.current?.update({ libp2p });
      },
      updateServices(services = {}) {
        servicePropsRef.current = {
          ...servicePropsRef.current,
          ...services,
        };
        bridgeRef.current?.update(services);
      },
      destroy() {
        bridgeRef.current?.destroy();
        bridgeRef.current = null;
      },
    }),
    []
  );

  return <div ref={containerRef} />;
});
