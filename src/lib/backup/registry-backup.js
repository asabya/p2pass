/**
 * Backup registry DB to Storacha via bridge.
 * @param {Object} bridge - Initialized OrbitDBStorachaBridge instance
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Object} registryDb - Registry database to backup
 * @returns {Promise<{success: boolean, blocksUploaded?: number, blocksTotal?: number, error?: string}>}
 */
export async function backupRegistryDb(bridge, orbitdb, registryDb) {
  try {
    const result = await bridge.backup(orbitdb, registryDb.address);
    return {
      success: true,
      blocksUploaded: result.blocksUploaded,
      blocksTotal: result.blocksTotal,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Restore registry from Storacha backup.
 * @param {Object} bridge - Initialized OrbitDBStorachaBridge instance
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Object} [options]
 * @returns {Promise<{success: boolean, database?: Object, entriesRecovered?: number, error?: string}>}
 */
export async function restoreRegistryDb(bridge, orbitdb, options = {}) {
  try {
    const result = await bridge.restoreFromSpace(orbitdb, {
      timeout: 120000,
      preferredDatabaseName: 'multi-device-registry',
      restartAfterRestore: true,
      verifyIntegrity: true,
      ...options,
    });
    return {
      success: true,
      database: result.database,
      entriesRecovered: result.entriesRecovered,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}
