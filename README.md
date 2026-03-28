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

## React Usage

```jsx
import { useRef } from 'react';
import { StorachaFab } from 'p2p-passkeys/react';

function App() {
  const fabRef = useRef(null);

  return <StorachaFab ref={fabRef} preferWorkerMode={true} />;
}
```

The React wrapper works, but it is less tested than the native Svelte component. If you want the most reliable integration and the best user experience, prefer the Svelte component.

For React, pass plain values and callbacks as normal props, but update live service objects through the wrapper ref:

```jsx
fabRef.current?.setLibp2p(libp2p);
fabRef.current?.setOrbitdb(orbitdb);
fabRef.current?.setDatabase(database);
fabRef.current?.updateServices({ libp2p, orbitdb, database });
```

## Worker Ed25519 Passkey Flow

Worker mode (`preferWorkerMode={true}`) uses WebAuthn purely for user verification and PRF seed extraction — the actual signing key is an Ed25519 keypair generated in a web worker, encrypted with the PRF-derived key.

### First Visit (Registration)

```
User clicks "Authenticate with Passkey"
  │
  ├─ navigator.credentials.create()
  │    ├─ Biometric prompt (Face ID / Touch ID / PIN)
  │    ├─ Creates discoverable credential (resident key)
  │    └─ PRF extension: eval({ first: deterministicSalt })
  │
  ├─ Extract PRF seed from credential response
  │    └─ Deterministic 32-byte seed derived from biometric + salt
  │
  ├─ Initialize Ed25519 keystore with PRF seed
  │    └─ PRF seed used as AES-GCM encryption key for the keystore
  │
  ├─ Generate Ed25519 keypair in web worker
  │    ├─ Random Ed25519 keypair created
  │    ├─ DID derived: did:key:z6Mk...
  │    └─ Archive exported (private key material)
  │
  ├─ Encrypt archive with PRF-derived AES key
  │    └─ { ciphertext, iv } stored as hex strings
  │
  ├─ Derive IPNS keypair from PRF seed (for recovery)
  │    └─ Deterministic Ed25519 key for IPNS manifest publishing
  │
  └─ Store credentials
       ├─ Encrypted archive → localStorage (bootstrap cache)
       ├─ Keypair + archive → OrbitDB registry (when available)
       └─ WebAuthn credential metadata → localStorage (for re-auth)
```

### Return Visit (Restoration)

```
User clicks "Authenticate with Passkey"
  │
  ├─ Find cached archive in localStorage
  │    └─ { did, ciphertext, iv, publicKeyHex }
  │
  ├─ Load stored WebAuthn credential metadata
  │
  ├─ navigator.credentials.get()
  │    ├─ Biometric prompt (same passkey as registration)
  │    └─ PRF extension: eval({ first: sameSalt })
  │
  ├─ Extract PRF seed → same seed as registration
  │
  ├─ Decrypt archive with PRF seed → same Ed25519 keypair
  │
  └─ Same DID restored: did:key:z6Mk...
```

### Recovery (New Device / Cleared Storage)

```
User clicks "Recover Identity"
  │
  ├─ navigator.credentials.get() (discoverable credential)
  │    ├─ Biometric prompt — passkey synced via iCloud/Google/etc.
  │    └─ PRF extension → same PRF seed
  │
  ├─ Derive IPNS keypair from PRF seed
  │
  ├─ Resolve IPNS manifest via w3name
  │    └─ Manifest contains: { ownerDid, archiveCID, delegation, registryAddress }
  │
  ├─ Fetch encrypted archive from IPFS gateway (no auth needed)
  │    └─ GET https://{archiveCID}.ipfs.w3s.link/ → { ciphertext, iv }
  │
  ├─ Decrypt archive with PRF seed → Ed25519 keypair restored
  │
  ├─ Connect to Storacha using delegation from manifest
  │
  └─ Same DID restored on new device
```

### Key Insight

The WebAuthn credential never signs anything — it's only used for:
1. **User verification** (biometric gate)
2. **PRF seed extraction** (deterministic secret derived from biometric + salt)

The PRF seed is the root of all derived keys:
- **Ed25519 DID keypair** — encrypted with PRF-derived AES key
- **IPNS recovery key** — deterministically derived from PRF seed
- **Keystore encryption** — PRF seed used as AES-GCM key

This means the same passkey on any device (via passkey sync) produces the same PRF seed, which unlocks the same DID identity.

### Signing Modes

| Mode | Security | Key Storage | Biometric |
|------|----------|-------------|-----------|
| Hardware Ed25519 | Highest | TPM/Secure Enclave | Per signature |
| Hardware P-256 | High | TPM/Secure Enclave | Per signature |
| Worker Ed25519 | Medium | Web worker + encrypted localStorage | On init only |

Use `preferWorkerMode={true}` for P2P/OrbitDB identity (required for multi-device). The component auto-detects the best available mode when `preferWorkerMode` is not set.

## Props

When using the Svelte components directly:

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

For React wrappers, `orbitdb`, `database`, and `libp2p` should be updated through the component ref instead of passed as live React props.

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
npm run dev:svelte     # Run the Svelte example app
npm test               # Run unit tests
npm run test:e2e       # Run Playwright E2E tests
npm run test:e2e:headed
npm run package        # Build library
```

## Testing

The Playwright suite covers:
- widget tab order and tab switching
- passkey authentication and DID display/copy
- peer info copy and invalid peer info handling
- p2p passkeys multi-device flows, including pairing approval and known-device auto-grant

Run the full Chromium E2E suite locally with:

```bash
npm run test:e2e -- --project=chromium --reporter=line
```

## CI

GitHub Actions runs the Playwright E2E suite on:
- every pull request
- every push to `master`

Workflow file:
- `.github/workflows/e2e.yml`

## Dependencies

- [`@le-space/orbitdb-identity-provider-webauthn-did`](https://github.com/Le-Space/orbitdb-identity-provider-webauthn-did) — WebAuthn crypto primitives
- [`@storacha/client`](https://github.com/storacha/w3up) — Storacha storage client
- [`orbitdb-storacha-bridge`](https://github.com/nicobao/orbitdb-storacha-bridge) — OrbitDB backup/restore
- Forked `@le-space/ucanto-*` packages for WebAuthn Ed25519/P-256 UCAN support

## License

MIT
