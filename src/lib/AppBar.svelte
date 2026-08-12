<script lang="ts">
	// The purple identity strip at the top of every page, shared so the wordmark,
	// GitHub / About links and the About modal stay identical across the locus
	// browser and the standalone GFA viewer. Pages differ only in their `tagline`,
	// the optional middle content (`children` — e.g. the query pill), and any
	// page-specific `links` placed before GitHub / About.
	import type { Snippet } from 'svelte';
	import AboutModal from './AboutModal.svelte';

	let {
		tagline,
		aboutSource = null,
		children,
		links
	}: {
		/** The sub-wordmark line, the one thing that names the current page. */
		tagline: string;
		/** Optional "Currently showing: …" line for the About modal (locus browser). */
		aboutSource?: string | null;
		/** Middle content (query pill, file name, …). */
		children?: Snippet;
		/** Page-specific links, rendered before the shared GitHub / About links. */
		links?: Snippet;
	} = $props();

	let aboutOpen = $state(false);
</script>

<header class="appbar">
	<div class="brand">
		<h1>Graphoscope</h1>
		<span class="tagline">{tagline}</span>
	</div>

	{@render children?.()}

	<div class="appbar-links">
		{@render links?.()}
		<a class="link-btn" href="https://github.com/MariaNattestad/graphoscope" target="_blank" rel="noopener">
			GitHub ↗
		</a>
		<button class="link-btn" onclick={() => (aboutOpen = true)}>About</button>
	</div>
</header>

{#if aboutOpen}
	<AboutModal source={aboutSource} onClose={() => (aboutOpen = false)} />
{/if}

<style>
	.appbar {
		/* Above the query scrim, so the strip (and any popover it hosts) stay bright
		   while the rest of the page dims behind them. */
		position: relative;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 1rem;
		/* A sleek purple strip, nodding to the disco-walks button's gradient. */
		background: linear-gradient(90deg, #2e1065 0%, #6d28d9 58%, #9333ea 100%);
		border-bottom: 1px solid #4c1d95;
		box-shadow: 0 1px 3px rgba(76, 29, 149, 0.25);
		flex: 0 0 auto;
	}
	.brand {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
	}
	.brand h1 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: #fff;
	}
	.tagline {
		color: #d6bcfa;
		font-size: 0.72rem;
	}
	.appbar-links {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	/* `:global` so page-specific links passed through the `links` snippet (which are
	   scoped to the parent, not this component) still pick up the bar's link style. */
	.appbar-links :global(.link-btn),
	.link-btn {
		background: none;
		border: none;
		color: #ede9fe;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		padding: 0.2rem 0.3rem;
		text-decoration: none;
	}
	.appbar-links :global(.link-btn:hover),
	.link-btn:hover {
		color: #fff;
		text-decoration: underline;
	}

	/* Phone header: the tagline, middle content and links don't all fit at ~375px,
	   so drop the tagline and shrink the wordmark; the middle content (the flexible
	   item) takes whatever space is left. */
	@media (max-width: 640px) {
		.appbar {
			gap: 0.5rem;
			padding: 0.4rem 0.6rem;
		}
		.tagline {
			display: none;
		}
		.brand {
			flex: 0 0 auto;
			min-width: 0;
		}
		.brand h1 {
			font-size: 1rem;
		}
		.appbar-links {
			flex: 0 0 auto;
			gap: 0.15rem;
		}
		.appbar-links :global(.link-btn),
		.link-btn {
			font-size: 0.78rem;
			padding: 0.2rem 0.25rem;
		}
	}
</style>
