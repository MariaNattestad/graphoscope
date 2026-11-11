<script lang="ts">
	// Problems with the link's parameters — an unknown name, a value that didn't
	// parse, a mark off the loaded window — shown rather than silently ignored, so
	// whoever built the link (often an AI agent reading the page) can see what to
	// fix. The same list is in window.graphoscope.warnings.
	import { base } from '$app/paths';

	let { warnings }: { warnings: string[] } = $props();
	let dismissed = $state(false);
</script>

{#if warnings.length > 0 && !dismissed}
	<div class="param-warnings" role="status" data-testid="param-warnings">
		<div class="pw-body">
			<b>Some link parameters weren't applied.</b>
			<ul>
				{#each warnings as w (w)}
					<li>{w}</li>
				{/each}
			</ul>
			<a href="{base}/llms.txt" target="_blank" rel="noopener">Parameter reference</a>
		</div>
		<button class="pw-dismiss" onclick={() => (dismissed = true)} aria-label="Dismiss">×</button>
	</div>
{/if}

<style>
	.param-warnings {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin: 0.5rem 0.75rem 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid #f5c26b;
		background: #fff8e6;
		color: #5c3b00;
		border-radius: 8px;
		font-size: 0.82rem;
		line-height: 1.45;
	}
	.pw-body {
		flex: 1;
	}
	ul {
		margin: 0.2rem 0 0.25rem;
		padding-left: 1.1rem;
	}
	a {
		color: #8a5a00;
	}
	.pw-dismiss {
		border: none;
		background: none;
		font-size: 1.1rem;
		line-height: 1;
		color: #8a5a00;
		cursor: pointer;
	}
</style>
