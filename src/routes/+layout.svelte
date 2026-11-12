<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { pageTitle } from '$lib/pageTitle';
	import { base } from '$app/paths';
	import { page } from '$app/state';

	const SITE = 'https://marianattestad.github.io';
	const canonical = $derived(`${SITE}${page.url.pathname}`);

	let { children } = $props();
</script>

<svelte:head>
	<title>{pageTitle('Graphoscope: HPRC pangenome graph viewer')}</title>
	<link rel="icon" href={favicon} />
	<link rel="canonical" href={canonical} />
	<meta
		name="description"
		content="Draw HPRC pangenome graphs by gene or locus, or any GFA file, in the browser. Every view is a URL; the parameter reference for AI agents and scripts is at llms.txt."
	/>
	<!-- Where an agent looks for how to drive the site: the llms.txt convention. -->
	<link rel="alternate" type="text/markdown" title="Graphoscope for AI agents (llms.txt)" href="{base}/llms.txt" />
</svelte:head>

<!-- For agents reading the page as text: the canvas has no text of its own, so
     point them at the URL parameters and the done signal. Hidden on screen. -->
<p class="agent-note">
	For AI agents and scripts: every view is set by URL parameters, and the page sets
	html[data-status="done"] when it is ready to screenshot. Reference: <a href="{base}/llms.txt">{base}/llms.txt</a>.
	About: <a href="{base}/about">{base}/about</a>.
	Numbers without drawing: <a href="{base}/api">{base}/api</a>.
</p>

{@render children()}

<style>
	.agent-note {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
</style>
