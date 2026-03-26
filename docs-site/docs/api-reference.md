---
sidebar_position: 6
---

# API Reference

All public exports from `p2p-passkeys`.

## UI Components

```js
import { StorachaFab, StorachaIntegration } from 'p2p-passkeys';
// React
import { StorachaFab, StorachaIntegration } from 'p2p-passkeys/react';
```

## Identity

```js
import { IdentityService, detectSigningMode, getStoredSigningMode } from 'p2p-passkeys';
```

| Export | Description |
|--------|-------------|
| `IdentityService` | Class — WebAuthn identity orchestrator |
| `detectSigningMode(options?)` | Auto-detect hardware vs worker signing mode |
| `getStoredSigningMode(registryDb?)` | Get cached mode without biometric prompt |

## UCAN / Storacha Auth

```js
import {
  createStorachaClient,
  parseDelegation,
  storeDelegation,
  loadStoredDelegation,
  clearStoredDelegation
} from 'p2p-passkeys';
```

| Export | Description |
|--------|-------------|
| `createStorachaClient(principal, delegation)` | Create authenticated Storacha client |
| `parseDelegation(proofString)` | Parse delegation (multibase, base64, CAR) |
| `storeDelegation(base64, registryDb?, spaceDid?)` | Persist delegation |
| `loadStoredDelegation(registryDb?)` | Load persisted delegation |
| `clearStoredDelegation(registryDb?, base64?)` | Remove delegation(s) |

## Device Registry

```js
import {
  openDeviceRegistry,
  registerDevice,
  listDevices,
  getDeviceByCredentialId,
  getDeviceByDID,
  grantDeviceWriteAccess,
  revokeDeviceAccess,
  storeDelegationEntry,
  listDelegations,
  getDelegation,
  removeDelegation,
  storeArchiveEntry,
  getArchiveEntry,
  storeKeypairEntry,
  getKeypairEntry,
  listKeypairs,
  hashCredentialId,
  coseToJwk
} from 'p2p-passkeys';
```

## Multi-Device Manager

```js
import { MultiDeviceManager } from 'p2p-passkeys';
```

## Pairing Protocol

```js
import {
  LINK_DEVICE_PROTOCOL,
  registerLinkDeviceHandler,
  unregisterLinkDeviceHandler,
  sendPairingRequest,
  detectDeviceLabel
} from 'p2p-passkeys';
```

## P2P Stack

```js
import {
  setupP2PStack,
  createLibp2pInstance,
  createHeliaInstance,
  cleanupP2PStack
} from 'p2p-passkeys';
```

| Export | Description |
|--------|-------------|
| `setupP2PStack(credential?, options?)` | Full stack: libp2p + Helia + OrbitDB |
| `createLibp2pInstance()` | libp2p only (before auth) |
| `createHeliaInstance(libp2p)` | Helia IPFS node |
| `cleanupP2PStack(stack)` | Shutdown everything |

## Recovery

```js
import {
  deriveIPNSKeyPair,
  computeDeterministicPrfSalt,
  recoverPrfSeed,
  createManifest,
  publishManifest,
  resolveManifest,
  resolveManifestByName,
  uploadArchiveToIPFS,
  fetchArchiveFromIPFS
} from 'p2p-passkeys';
```

## Backup

```js
import { backupRegistryDb, restoreRegistryDb } from 'p2p-passkeys';
```

## Storacha Utilities

```js
import { listSpaces, getSpaceUsage, listStorachaFiles } from 'p2p-passkeys';
```
