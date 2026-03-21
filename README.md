# p2p-passkeys

Standalone Svelte component for P2P passkey-based DID identities with [Storacha](https://storacha.network) decentralized backup.

Drop in `<StorachaFab />` and get:
- WebAuthn passkey authentication (hardware Ed25519, P-256, or worker Ed25519 fallback)
- UCAN delegation-based Storacha access
- OrbitDB backup/restore with progress tracking
- P2P device linking via libp2p with copy/paste peer info
- Multi-device registry with automatic device detection
- Floating action button with Storacha branding

## Install

```bash
npm install p2p-passkeys
```

## Usage

```svelte
<script>
  import { StorachaFab } from 'p2p-passkeys';
</script>

<StorachaFab
  {orbitdb}
  {libp2p}
  onAuthenticate={handleAuthenticate}
  preferWorkerMode={true}
/>
```

The component handles everything internally:
1. Click the floating Storacha button (bottom-right)
2. "Authenticate with Passkey" → biometric prompt → DID created
3. Two tabs appear: **Storacha** (backup/restore) and **P2P Passkeys** (device linking)
4. Paste a UCAN delegation → connected to Storacha → backup/restore enabled
5. P2P Passkeys tab shows connection status, peer info, and linked devices

## Auth Flow

```
First visit:
  Authenticate with Passkey
    → navigator.credentials.create() (biometric)
    → PRF seed extracted (biometric)
    → Ed25519 DID generated (did:key:z6Mk...)
    → Encrypted archive cached in localStorage

Return visit:
  Authenticate with Passkey
    → Cached archive found
    → navigator.credentials.get() (biometric)
    → Same DID restored
```

### Signing Modes

| Mode | Security | Key Storage | Biometric |
|------|----------|-------------|-----------|
| Hardware Ed25519 | Highest | TPM/Secure Enclave | Per signature |
| Hardware P-256 | High | TPM/Secure Enclave | Per signature |
| Worker Ed25519 | Medium | Web worker + encrypted localStorage | On init only |

Use `preferWorkerMode={true}` for P2P/OrbitDB identity (required for multi-device). The component auto-detects the best available mode when `preferWorkerMode` is not set.

## Props

When using `StorachaFab` or `StorachaIntegration` directly:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orbitdb` | object | `null` | OrbitDB instance (for backup/restore) |
| `database` | object | `null` | Database instance to backup |
| `isInitialized` | boolean | `false` | Whether OrbitDB is ready |
| `entryCount` | number | `0` | Database entry count |
| `databaseName` | string | `'restored-db'` | Name for restored database |
| `onRestore` | function | `() => {}` | Called when restore completes |
| `onBackup` | function | `() => {}` | Called when backup completes |
| `onAuthenticate` | function | `() => {}` | Called after passkey auth (receives signingMode) |
| `libp2p` | object | `null` | libp2p instance for P2P connectivity |
| `preferWorkerMode` | boolean | `false` | Skip hardware mode, use worker Ed25519 |

## Components

### `StorachaFab`
Floating action button (bottom-right) with the Storacha rooster logo. Opens the integration panel as an overlay. Self-contained — no Tailwind or external CSS required.

### `StorachaIntegration`
The panel component itself. Can be embedded inline instead of as a floating panel.

## Programmatic API

```js
import {
  IdentityService, createStorachaClient, parseDelegation,
  setupP2PStack, createLibp2pInstance, cleanupP2PStack
} from 'p2p-passkeys';

// Create identity (worker mode for P2P)
const identity = new IdentityService();
const { mode, did, algorithm } = await identity.initialize(undefined, { preferWorkerMode: true });

// Get UCAN principal
const principal = await identity.getPrincipal();

// Connect to Storacha
const delegation = await parseDelegation(delegationBase64);
const client = await createStorachaClient(principal, delegation);

// Start P2P stack
const libp2p = await createLibp2pInstance();
// After auth, upgrade to full stack with OrbitDB:
const stack = await setupP2PStack(credential);
```

## Development

```bash
npm run dev:example    # Run example app
npm test               # Run unit tests
npm run package        # Build library
```

## Dependencies

- [`@le-space/orbitdb-identity-provider-webauthn-did`](https://github.com/Le-Space/orbitdb-identity-provider-webauthn-did) — WebAuthn crypto primitives
- [`@storacha/client`](https://github.com/storacha/w3up) — Storacha storage client
- [`orbitdb-storacha-bridge`](https://github.com/nicobao/orbitdb-storacha-bridge) — OrbitDB backup/restore
- Forked `@le-space/ucanto-*` packages for WebAuthn Ed25519/P-256 UCAN support

## License

MIT
