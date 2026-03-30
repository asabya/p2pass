# P2Pass (`@le-space/p2pass`)

[![Tests](https://github.com/asabya/p2pass/actions/workflows/tests.yml/badge.svg)](https://github.com/asabya/p2pass/actions/workflows/tests.yml)

Standalone Svelte component for passkey-based DID identities replicating p2p between devices and [Storacha](https://storacha.network) decentralized backup. Published on npm as **`@le-space/p2pass`** (Le Space).

Drop in `<StorachaFab />` (or the **`P2Pass`** named export — same component) and get:

- WebAuthn passkey authentication (hardware Ed25519, P-256, or worker Ed25519 fallback)
- UCAN delegation-based Storacha access
- OrbitDB backup/restore with progress tracking
- P2P device linking via libp2p with copy/paste peer info
- Multi-device registry with automatic device detection
- Floating action button with Storacha branding

## Install

```bash
npm install @le-space/p2pass
```

## Usage

```svelte
<script>
  import { StorachaFab } from '@le-space/p2pass';
</script>

<StorachaFab {orbitdb} {libp2p} onAuthenticate={handleAuthenticate} preferWorkerMode={true} />
```

The component handles everything internally:

1. Click the floating Storacha button (bottom-right)
2. Choose a **signing mode** (hardware Ed25519 with P-256 fallback, hardware P-256 only, or worker Ed25519), then **Authenticate with Passkey** → biometric prompt → DID created
3. Two tabs appear: **P2P Passkeys** (device linking) and **Storacha** (backup/restore); P2P Passkeys is the default
4. Paste a UCAN delegation → connected to Storacha → backup/restore enabled
5. The P2Pass tab shows connection status, peer info, and linked devices

## React Usage

```jsx
import { useRef } from 'react';
import { P2Pass } from '@le-space/p2pass/react';

function App() {
  const fabRef = useRef(null);

  return <P2Pass ref={fabRef} preferWorkerMode={true} />;
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

| Mode             | Security | Key Storage                         | Biometric     |
| ---------------- | -------- | ----------------------------------- | ------------- |
| Hardware Ed25519 | Highest  | TPM/Secure Enclave                  | Per signature |
| Hardware P-256   | High     | TPM/Secure Enclave                  | Per signature |
| Worker Ed25519   | Medium   | Web worker + encrypted localStorage | On init only  |

**Worker Ed25519** matches typical OrbitDB multi-device flows (signing key in a worker). **Hardware** modes keep private keys in the authenticator; hardware Ed25519 lists Ed25519 first and may obtain **P-256** if the device does not support hardware Ed25519. Pick the mode in the panel before authenticating, or set `signingPreference="worker"` / `preferWorkerMode` on the component. If neither is set, the component can auto-detect a reasonable default.

## Props

When using the Svelte components directly:

| Prop                | Type     | Default         | Description                                                                              |
| ------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------- |
| `orbitdb`           | object   | `null`          | OrbitDB instance (for backup/restore)                                                    |
| `database`          | object   | `null`          | Database instance to backup                                                              |
| `isInitialized`     | boolean  | `false`         | Whether OrbitDB is ready                                                                 |
| `entryCount`        | number   | `0`             | Database entry count                                                                     |
| `databaseName`      | string   | `'restored-db'` | Name for restored database                                                               |
| `onRestore`         | function | `() => {}`      | Called when restore completes                                                            |
| `onBackup`          | function | `() => {}`      | Called when backup completes                                                             |
| `onAuthenticate`    | function | `() => {}`      | Called after passkey auth (receives signingMode)                                         |
| `libp2p`            | object   | `null`          | libp2p instance for P2P connectivity                                                     |
| `signingPreference` | `string` | `null`          | `'hardware-ed25519'`, `'hardware-p256'`, or `'worker'` — overrides the in-panel selector |
| `preferWorkerMode`  | boolean  | `false`         | Deprecated; same as `signingPreference="worker"`                                         |

For React wrappers, `orbitdb`, `database`, and `libp2p` should be updated through the component ref instead of passed as live React props.

## Components

### `StorachaFab` (`P2Pass`)

Floating action button (bottom-right) with the Storacha rooster logo. Opens the integration panel as an overlay. Self-contained — no Tailwind or external CSS required. The **`P2Pass`** export is an alias for the same Svelte component.

### `StorachaIntegration` (`P2PassPanel`)

The panel component itself. Can be embedded inline instead of as a floating panel. **`P2PassPanel`** is a named alias.

## Programmatic API

```js
import {
  IdentityService,
  createStorachaClient,
  parseDelegation,
  setupP2PStack,
  createLibp2pInstance,
  cleanupP2PStack,
} from '@le-space/p2pass';

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

### End-to-end tests

Playwright drives the **Svelte example app** in Chromium (with optional virtual WebAuthn where configured). Primary integration specs live in **`e2e/`** (for example `link-devices.spec.js` for multi-device pairing). The **`tests/`** directory also contains additional widget-style E2E tests; the unified Playwright config can run both suites.

**Run:**

```bash
npm run test:e2e       # headless; starts relay + Vite for e2e/ specs (see playwright.config.js)
npm run test:e2e:ui    # Playwright UI mode (debugging)
```

For `e2e/`, `playwright.config.js` starts **`scripts/e2e-with-relay.mjs`**, which:

1. Launches **orbitdb-relay-pinner** (local libp2p relay).
2. Fetches WebSocket bootstrap multiaddrs from the relay’s HTTP API and passes them to Vite as **`VITE_BOOTSTRAP_PEERS`** so browsers can connect.
3. Runs **`svelte-package`** and the **example Vite dev server** on port **5173**.

First-time setup may require browser binaries:

```bash
npx playwright install chromium
```

**Reuse a running dev server** (you must still provide a relay and matching `VITE_BOOTSTRAP_PEERS` yourself if you skip the script):

```bash
PW_REUSE_SERVER=1 npm run test:e2e
```

Failed runs write HTML reports, screenshots, traces, and video under `test-results/` (see Playwright output for paths).

**Signing mode in e2e:** set `E2E_SIGNING_MODE` to `worker`, `hardware-ed25519`, or `hardware-p256` (default in helpers is `worker`). CI runs the link-devices spec **three times** (matrix), one per mode.

```bash
E2E_SIGNING_MODE=hardware-ed25519 npm run test:e2e
```

## CI

GitHub Actions runs unit tests (Vitest) and Playwright on **pull requests and pushes**. Workflow: **`.github/workflows/tests.yml`**.

## Dependencies

- [`@le-space/orbitdb-identity-provider-webauthn-did`](https://github.com/Le-Space/orbitdb-identity-provider-webauthn-did) — WebAuthn crypto primitives
- [`@storacha/client`](https://github.com/storacha/w3up) — Storacha storage client
- [`orbitdb-storacha-bridge`](https://github.com/nicobao/orbitdb-storacha-bridge) — OrbitDB backup/restore
- Forked `@le-space/ucanto-*` packages for WebAuthn Ed25519/P-256 UCAN support

## License

MIT
