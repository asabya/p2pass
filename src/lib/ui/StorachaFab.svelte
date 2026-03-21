<script>
	import StorachaIntegration from './StorachaIntegration.svelte';

	let {
		orbitdb = null,
		database = null,
		isInitialized = false,
		entryCount = 0,
		databaseName = 'restored-db',
		onRestore = () => {},
		onBackup = () => {},
		onAuthenticate = () => {},
		libp2p = null,
		preferWorkerMode = false
	} = $props();

	let showPanel = $state(false);
	let isHovered = $state(false);
</script>

<!-- Floating Storacha FAB Button -->
<button
	onclick={() => (showPanel = !showPanel)}
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	title={showPanel ? 'Hide Storacha Backup' : 'Open Storacha - Decentralized Storage'}
	aria-label={showPanel ? 'Hide Storacha backup integration' : 'Open Storacha backup integration'}
	style="
		position: fixed;
		right: 1.5rem;
		bottom: 6rem;
		z-index: 10000;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 4rem;
		width: 4rem;
		border-radius: 9999px;
		border: 2px solid white;
		color: white;
		cursor: pointer;
		padding: 0;
		outline: none;
		background: linear-gradient(135deg, #E91315 0%, #FFC83F 100%);
		box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
		transition: all 300ms ease;
		transform: {showPanel ? 'scale(1.05) rotate(12deg)' : isHovered ? 'scale(1.1) rotate(6deg)' : 'scale(1)'};
		font-family: 'Epilogue', -apple-system, BlinkMacSystemFont, sans-serif;
	"
>
	<svg
		width="28"
		height="32"
		viewBox="0 0 154 172"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		style="transition: transform 300ms;"
	>
		<path d="M110.999 41.5313H71.4081C70.2881 41.5313 69.334 42.4869 69.334 43.6087V154.359C69.334 159.461 69.1847 164.596 69.334 169.698C69.334 169.773 69.334 169.839 69.334 169.914C69.334 171.036 70.2881 171.992 71.4081 171.992H111.646C112.766 171.992 113.72 171.036 113.72 169.914V129.613L111.646 131.69H151.884C153.004 131.69 153.959 130.735 153.959 129.613V95.7513C153.959 91.6796 154.041 87.5996 153.942 83.5362C153.685 72.9996 149.512 62.8038 142.318 55.1091C135.125 47.4144 125.319 42.7029 114.907 41.7141C113.604 41.5894 112.302 41.5313 110.991 41.5313C108.319 41.523 108.319 45.6777 110.991 45.6861C120.772 45.7193 130.305 49.4171 137.457 56.1229C144.608 62.8287 149.022 71.9443 149.702 81.6416C149.993 85.813 149.802 90.0592 149.802 94.2306V124.677C149.802 126.231 149.694 127.826 149.802 129.38C149.802 129.455 149.802 129.53 149.802 129.604L151.876 127.527H111.638C110.518 127.527 109.564 128.483 109.564 129.604V169.906L111.638 167.829H71.3998L73.474 169.906V48.7689C73.474 47.1319 73.5818 45.4617 73.474 43.8247C73.474 43.7499 73.474 43.6834 73.474 43.6087L71.3998 45.6861H110.991C113.662 45.6861 113.662 41.5313 110.991 41.5313H110.999Z" fill="currentColor"/>
		<path d="M108.519 68.9694C108.452 62.9532 104.727 57.66 99.1103 55.5494C93.4935 53.4387 87.0886 55.2669 83.3718 59.779C79.5554 64.4157 78.9165 71.0966 82.0277 76.2901C85.1389 81.4836 91.2037 84.0762 97.1025 82.9544C103.723 81.6996 108.444 75.617 108.527 68.9694C108.56 66.2937 104.412 66.2937 104.379 68.9694C104.329 73.1325 101.749 77.0878 97.7579 78.4838C93.7673 79.8798 89.03 78.6749 86.3087 75.2265C83.5875 71.778 83.4879 67.2077 85.6865 63.6346C87.8851 60.0615 92.2076 58.1752 96.2811 59.0477C100.985 60.0532 104.32 64.1664 104.379 68.9777C104.412 71.6533 108.56 71.6533 108.527 68.9777L108.519 68.9694Z" fill="currentColor"/>
		<path d="M94.265 73.3237C96.666 73.3237 98.6124 71.3742 98.6124 68.9695C98.6124 66.5647 96.666 64.6152 94.265 64.6152C91.8641 64.6152 89.9177 66.5647 89.9177 68.9695C89.9177 71.3742 91.8641 73.3237 94.265 73.3237Z" fill="currentColor"/>
		<path d="M71.4081 36.8029H132.429C144.642 36.8029 150.64 28.5764 151.752 23.8981C152.863 19.2281 147.263 7.43685 133.624 22.1199C133.624 22.1199 141.754 6.32336 130.869 2.76686C119.984 -0.789637 107.473 10.1042 102.512 20.5577C102.512 20.5577 103.109 7.6529 91.8923 10.769C80.6754 13.8851 71.4081 36.7946 71.4081 36.7946V36.8029Z" fill="currentColor"/>
		<path d="M18.186 66.1195C17.879 66.0531 17.8707 65.6126 18.1694 65.5212C31.6927 61.4246 42.2376 70.7895 46.0457 76.6312C48.3189 80.1212 51.6956 83.3868 54.1182 85.5058C55.4042 86.6276 55.0889 88.7216 53.5292 89.4113C52.4589 89.8849 50.7498 90.9402 49.2316 91.846C46.3859 93.5495 42.4699 100.554 33.0948 101.884C26.1921 102.856 17.6716 98.7014 13.6561 96.4329C13.3408 96.2584 13.5399 95.793 13.8884 95.8761C19.8536 97.3137 24.2673 94.8291 22.4753 91.5302C21.1395 89.0706 17.5223 88.1482 12.2789 90.2339C7.61621 92.087 2.07414 86.0376 0.597357 84.2843C0.439724 84.1015 0.555875 83.8106 0.788177 83.7857C5.16044 83.3453 9.41656 78.8664 12.2291 74.1715C14.801 69.8755 20.5837 69.4849 22.4255 69.4683C22.6744 69.4683 22.8154 69.1858 22.6661 68.9863C22.0605 68.1886 20.6169 66.6513 18.186 66.1112V66.1195ZM30.1413 87.9571C29.7264 87.9322 29.4692 88.3975 29.7181 88.7299C30.7967 90.1342 33.5345 92.5855 38.7448 90.9818C45.8134 88.8047 46.1038 84.3175 40.9516 80.3455C36.4798 76.9054 29.2204 77.5618 24.8647 79.8968C24.4084 80.1461 24.5992 80.8441 25.1136 80.8026C26.8641 80.6696 30.133 80.8607 32.0827 82.2401C34.7126 84.0932 35.617 88.331 30.1413 87.9654V87.9571Z" fill="currentColor"/>
	</svg>
</button>

{#if showPanel}
	<!-- Backdrop overlay -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		onclick={() => (showPanel = false)}
		onkeydown={(e) => e.key === 'Escape' && (showPanel = false)}
		role="presentation"
		style="
			position: fixed;
			inset: 0;
			z-index: 9998;
			background: radial-gradient(circle at center, rgba(233, 19, 21, 0.15) 0%, rgba(233, 19, 21, 0.05) 70%, transparent 100%);
			backdrop-filter: blur(2px);
			-webkit-backdrop-filter: blur(2px);
		"
	></div>

	<!-- Floating panel -->
	<div
		style="
			position: fixed;
			right: 1.5rem;
			bottom: 12rem;
			z-index: 9999;
			width: 24rem;
			max-width: calc(100vw - 3rem);
		"
	>
		<StorachaIntegration
			{orbitdb}
			{database}
			{isInitialized}
			{entryCount}
			{databaseName}
			{onRestore}
			{onBackup}
			{onAuthenticate}
			{libp2p}
			{preferWorkerMode}
		/>
	</div>
{/if}
