/**
 * Mounts Svelte UI components inside a DOM node for React (or other hosts) via `svelte` `mount` / `unmount`.
 *
 * @module react/bridge.svelte
 */

import { mount, unmount } from 'svelte';
import SvelteFab from '../ui/P2Pass.svelte';
import SvelteIntegration from '../ui/P2PassPanel.svelte';

/**
 * @param {typeof import('svelte').SvelteComponent} Component
 * @param {Element} target
 * @param {Record<string, unknown>} initialProps
 */
function createWrapper(Component, target, initialProps) {
  let props = $state({ ...initialProps });
  const instance = mount(Component, { target, props });
  return {
    /**
     * @param {Record<string, unknown>} newProps
     */
    update(newProps) {
      for (const key of Object.keys(newProps)) {
        props[key] = newProps[key];
      }
    },
    destroy() {
      unmount(instance);
    },
  };
}

/**
 * Mount the `P2Pass` Svelte component (floating button + panel) into `target`.
 *
 * @param {Element} target
 * @param {Record<string, unknown>} initialProps — forwarded to the component
 * @returns {{ update: (p: Record<string, unknown>) => void, destroy: () => void }}
 */
export function createFab(target, initialProps) {
  return createWrapper(SvelteFab, target, initialProps);
}

/**
 * Mount the `P2PassPanel` Svelte component (full panel) into `target`.
 *
 * @param {Element} target
 * @param {Record<string, unknown>} initialProps
 * @returns {{ update: (p: Record<string, unknown>) => void, destroy: () => void }}
 */
export function createIntegration(target, initialProps) {
  return createWrapper(SvelteIntegration, target, initialProps);
}
