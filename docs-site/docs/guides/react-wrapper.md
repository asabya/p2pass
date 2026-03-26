---
sidebar_position: 1
---

# React Wrapper

The library provides React wrapper components that mount the existing Svelte widget into a DOM node.

## How It Works

A `.svelte.js` bridge file uses Svelte 5's `$state` runes to create reactive props. The React wrapper uses `useRef` + `useEffect` to mount and update the Svelte component.

```
React props → bridge.update() → $state mutation → Svelte reactivity
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
import { StorachaFab } from 'p2p-passkeys/react';
import { setupP2PStack, createLibp2pInstance } from 'p2p-passkeys';

function App() {
  const [orbitdb, setOrbitdb] = useState(null);
  const [libp2p, setLibp2p] = useState(null);

  useEffect(() => {
    createLibp2pInstance().then(setLibp2p);
  }, []);

  const handleAuthenticate = useCallback(async (signingMode) => {
    const stack = await setupP2PStack(null, { libp2p });
    setOrbitdb(stack.orbitdb);
    setLibp2p(stack.libp2p);
  }, [libp2p]);

  return (
    <StorachaFab
      orbitdb={orbitdb}
      libp2p={libp2p}
      preferWorkerMode={true}
      onAuthenticate={handleAuthenticate}
    />
  );
}
```

## Available Components

### `StorachaFab`

Floating action button with the full Storacha integration panel. Same props as the Svelte version.

### `StorachaIntegration`

The integration panel without the FAB wrapper. Useful when you want to embed the panel in your own layout.

```jsx
import { StorachaIntegration } from 'p2p-passkeys/react';
```

## How Props Update

Props are passed through to the Svelte component reactively. When React state changes trigger a re-render, the wrapper calls `bridge.update()` which mutates the `$state` proxy, triggering Svelte's reactivity system.

Since the Svelte components ship uncompiled, the consumer's bundler (with `@sveltejs/vite-plugin-svelte`) compiles both the `.svelte` components and the `.svelte.js` bridge file.
