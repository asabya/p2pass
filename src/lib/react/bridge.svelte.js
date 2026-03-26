import { mount, unmount } from 'svelte';
import SvelteFab from '../ui/StorachaFab.svelte';
import SvelteIntegration from '../ui/StorachaIntegration.svelte';

function createWrapper(Component, target, initialProps) {
	let props = $state({ ...initialProps });
	const instance = mount(Component, { target, props });
	return {
		update(newProps) {
			for (const key of Object.keys(newProps)) {
				props[key] = newProps[key];
			}
		},
		destroy() {
			unmount(instance);
		}
	};
}

export function createFab(target, initialProps) {
	return createWrapper(SvelteFab, target, initialProps);
}

export function createIntegration(target, initialProps) {
	return createWrapper(SvelteIntegration, target, initialProps);
}
