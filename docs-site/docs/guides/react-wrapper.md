---
sidebar_position: 1
---

# React Wrapper

The library provides React wrapper components that mount the existing Svelte widget into a DOM node.

## How It Works

A `.svelte.js` bridge file uses Svelte 5's `$state` runes to create reactive props. The React wrapper mounts the Svelte component once, then updates plain props reactively and live service objects imperatively through a `ref`.

```
React props → bridge.update() → $state mutation → Svelte reactivity
React ref methods → bridge.update() → live service updates
```

## Installation

```bash
npm install p2p-passkeys
```

Your Vite config needs both React and Svelte plugins:

```js
// vite.config.js
import react from '@vitejs/plugin-react';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default {
  plugins: [
    react(),
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

## Usage

```jsx
import { useEffect, useRef } from 'react';
import { StorachaFab } from 'p2p-passkeys/react';
import { setupP2PStack, createLibp2pInstance } from 'p2p-passkeys';

function App() {
  const fabRef = useRef(null);
  const libp2pRef = useRef(null);
  const p2pStackRef = useRef(null);

  useEffect(() => {
    createLibp2pInstance().then((libp2p) => {
      libp2pRef.current = libp2p;
      fabRef.current?.setLibp2p(libp2p);
    });

    return () => {
      if (libp2pRef.current) libp2pRef.current.stop();
    };
  }, []);

  async function handleAuthenticate() {
    const stack = await setupP2PStack(null, { libp2p: libp2pRef.current });
    p2pStackRef.current = stack;
    libp2pRef.current = stack.libp2p;
    fabRef.current?.updateServices({
      orbitdb: stack.orbitdb,
      libp2p: stack.libp2p
    });
  }

  return (
    <StorachaFab
      ref={fabRef}
      preferWorkerMode={true}
      onAuthenticate={handleAuthenticate}
    />
  );
}
```

## Live Service Objects

Do not pass live objects such as `libp2p`, `orbitdb`, or `database` as normal React props.

React wrapper refs expose these methods for service updates:

```jsx
fabRef.current?.setLibp2p(libp2p);
fabRef.current?.setOrbitdb(orbitdb);
fabRef.current?.setDatabase(database);
fabRef.current?.updateServices({ libp2p, orbitdb, database });
```

Use regular React props only for plain values and callbacks like:
- `isInitialized`
- `entryCount`
- `databaseName`
- `onAuthenticate`
- `onBackup`
- `onRestore`
- `preferWorkerMode`

## Available Components

### `StorachaFab`

Floating action button with the full Storacha integration panel.

### `StorachaIntegration`

The integration panel without the FAB wrapper. Useful when you want to embed the panel in your own layout.

```jsx
import { StorachaIntegration } from 'p2p-passkeys/react';
```

## How Props Update

Plain props are passed through to the Svelte component reactively. When React state changes trigger a re-render, the wrapper calls `bridge.update()` which mutates the `$state` proxy, triggering Svelte's reactivity system.

Live service objects are updated through the wrapper ref to avoid React dev-mode inspection of complex proxy/service objects.

Since the Svelte components ship uncompiled, the consumer's bundler (with `@sveltejs/vite-plugin-svelte`) compiles both the `.svelte` components and the `.svelte.js` bridge file.
