---
sidebar_position: 2
---

# Getting Started

## Installation

```bash
npm install p2p-passkeys
```

## Svelte Usage

The simplest integration is the floating action button:

```svelte
<script>
  import { StorachaFab } from 'p2p-passkeys';
</script>

<StorachaFab preferWorkerMode={true} />
```

For full control, use `StorachaIntegration` directly:

```svelte
<script>
  import { StorachaIntegration } from 'p2p-passkeys';
</script>

<StorachaIntegration
  orbitdb={myOrbitdb}
  libp2p={myLibp2p}
  preferWorkerMode={true}
  onAuthenticate={handleAuth}
  onBackup={handleBackup}
  onRestore={handleRestore}
/>
```

## React Usage

```jsx
import { StorachaFab } from 'p2p-passkeys/react';

function App() {
  return <StorachaFab preferWorkerMode={true} />;
}
```

:::info
React consumers need `svelte` and `@sveltejs/vite-plugin-svelte` in their Vite config since the Svelte components are compiled at build time.
:::

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orbitdb` | `object` | `null` | OrbitDB instance |
| `database` | `object` | `null` | Current OrbitDB database |
| `isInitialized` | `boolean` | `false` | Whether OrbitDB is ready |
| `entryCount` | `number` | `0` | Number of entries in database |
| `databaseName` | `string` | `'restored-db'` | Name for restored databases |
| `onRestore` | `function` | `() => {}` | Called when restore completes |
| `onBackup` | `function` | `() => {}` | Called when backup completes |
| `onAuthenticate` | `function` | `() => {}` | Called after passkey auth (awaited) |
| `libp2p` | `object` | `null` | libp2p instance for P2P |
| `preferWorkerMode` | `boolean` | `false` | Use worker Ed25519 instead of hardware |

## With P2P Stack

For the full experience with P2P connectivity:

```svelte
<script>
  import { StorachaFab, setupP2PStack, createLibp2pInstance, cleanupP2PStack } from 'p2p-passkeys';
  import { onMount } from 'svelte';

  let orbitdb = $state(null);
  let libp2p = $state(null);

  onMount(async () => {
    // Start libp2p first (no credential needed)
    libp2p = await createLibp2pInstance();

    return () => {
      if (libp2p) libp2p.stop();
    };
  });

  async function handleAuthenticate(signingMode) {
    // After auth, start full P2P stack with OrbitDB
    const stack = await setupP2PStack(null, { libp2p });
    orbitdb = stack.orbitdb;
    libp2p = stack.libp2p;
  }
</script>

<StorachaFab
  {orbitdb}
  {libp2p}
  preferWorkerMode={true}
  onAuthenticate={handleAuthenticate}
/>
```

## Vite Configuration

The consuming app needs node polyfills and must exclude the WebAuthn provider from optimization:

```js
// vite.config.js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default {
  plugins: [
    svelte(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'events', 'path']
    })
  ],
  optimizeDeps: {
    exclude: ['@le-space/orbitdb-identity-provider-webauthn-did']
  },
  worker: { format: 'es' }
};
```
