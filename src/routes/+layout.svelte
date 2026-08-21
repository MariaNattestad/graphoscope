<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { pageTitle } from '$lib/pageTitle';

	let { children } = $props();
</script>

<svelte:head>
	<title>{pageTitle('Graphoscope')}</title>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
