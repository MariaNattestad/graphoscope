<script lang="ts">
	// Simplification playground: pick an example graph (the same fixtures the unit
	// tests assert on), tweak the threshold, and compare the original vs simplified
	// graph side by side through the shared layout widget, with a stats/diff panel.
	import { parseGfa } from '$lib/gfa';
	import { simplify } from '$lib/graph/simplify';
	import { ALL_FIXTURES, type Fixture } from '$lib/graph/fixtures';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { base } from '$app/paths';

	let selectedId = $state(ALL_FIXTURES[0].id);
	let maxVariant = $state(50);
	let showSimplified = $state(true);

	const fixture = $derived<Fixture>(
		ALL_FIXTURES.find((f) => f.id === selectedId) ?? ALL_FIXTURES[0]
	);
	const parsed = $derived(parseGfa(fixture.gfaText));
	const result = $derived(
		simplify(parsed, { referenceSample: fixture.referenceSample, maxVariant })
	);
</script>

<main>
	<header>
		<h1>Simplification playground</h1>
		<p class="sub">
			Reference-guided small-variant popping + unchop, run on example graphs. These are the exact
			fixtures the <code>simplify</code> tests assert on. <a href="{base}/">← back to the browser</a>
		</p>
	</header>

	<section class="panel">
		<div class="row">
			<label>
				Example
				<select bind:value={selectedId}>
					<optgroup label="synthetic">
						{#each ALL_FIXTURES.filter((f) => f.kind === 'synthetic') as f (f.id)}
							<option value={f.id}>{f.label}</option>
						{/each}
					</optgroup>
					<optgroup label="real loci">
						{#each ALL_FIXTURES.filter((f) => f.kind === 'real') as f (f.id)}
							<option value={f.id}>{f.label}</option>
						{/each}
					</optgroup>
				</select>
			</label>
			<label>
				collapse variants ≤
				<input type="number" min="1" max="2000" bind:value={maxVariant} /> bp
			</label>
			<label class="chk">
				<input type="checkbox" bind:checked={showSimplified} /> show simplified side
			</label>
		</div>
		<p class="desc">{fixture.description}</p>
	</section>

	<section class="panel">
		<div class="statgrid">
			<div><span>segments</span><b>{parsed.segments.size} → {result.stats.segmentsAfter}</b></div>
			<div><span>links</span><b>{parsed.links.length} → {result.stats.linksAfter}</b></div>
			<div><span>sites collapsed</span><b>{result.stats.sites}</b></div>
			<div><span>nodes removed</span><b>{result.stats.nodesRemoved}</b></div>
			<div><span>SNPs</span><b>{result.stats.snpCount}</b></div>
			<div><span>alt bp condensed</span><b>{result.stats.basesRemoved}</b></div>
			<div><span>unchop merges</span><b>{result.stats.unchopMerges}</b></div>
		</div>
		{#if fixture.kind === 'synthetic' && fixture.expect}
			<p class="muted small">
				expected: {fixture.expect.sites} sites · {fixture.expect.nodesRemoved} nodes · {fixture
					.expect.snpCount} SNPs · {fixture.expect.basesRemoved} alt bp
			</p>
		{/if}
	</section>

	<div class="compare" class:solo={!showSimplified}>
		<section class="panel">
			<h2 class="panel-title">Original · {parsed.segments.size} nodes</h2>
			<GraphLayoutView gfa={parsed} referenceSample={fixture.referenceSample} />
		</section>
		{#if showSimplified}
			<section class="panel">
				<h2 class="panel-title">Simplified · {result.stats.segmentsAfter} nodes</h2>
				<GraphLayoutView gfa={result.gfa} referenceSample={fixture.referenceSample} />
			</section>
		{/if}
	</div>

	{#if result.sites.length > 0}
		<section class="panel">
			<h2 class="panel-title">Collapsed sites ({result.sites.length})</h2>
			<table>
				<thead>
					<tr><th>entry→exit</th><th>ref span</th><th>nodes</th><th>SNPs</th><th>alt bp</th><th>longest path</th><th>haplotypes</th></tr>
				</thead>
				<tbody>
					{#each result.sites.slice(0, 40) as s (s.entry + '-' + s.exit)}
						<tr>
							<td class="mono">{s.entry}→{s.exit}</td>
							<td>{s.refSpan}</td>
							<td>{s.nodesRemoved}</td>
							<td>{s.snpCount}</td>
							<td>{s.basesRemoved}</td>
							<td>{s.maxPathBases}</td>
							<td>{s.haplotypesAffected}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if result.sites.length > 40}<p class="muted small">showing 40 of {result.sites.length}</p>{/if}
		</section>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		color: #1a1a1a;
		background: #fff;
	}
	main {
		max-width: 1300px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 0 0 0.2rem;
		font-size: 1.5rem;
	}
	.sub {
		margin: 0 0 1.2rem;
		color: #555;
	}
	.panel {
		border: 1px solid #e6e6e6;
		border-radius: 10px;
		padding: 1rem;
		margin-bottom: 1rem;
	}
	.panel-title {
		margin: 0 0 0.8rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: #444;
	}
	.row {
		display: flex;
		gap: 1.2rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.chk {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	label {
		font-size: 0.9rem;
	}
	select,
	input[type='number'] {
		font: inherit;
		padding: 0.3rem 0.45rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	input[type='number'] {
		width: 5rem;
	}
	.desc {
		margin: 0.8rem 0 0;
		color: #555;
		font-size: 0.9rem;
	}
	.statgrid {
		display: flex;
		gap: 1.6rem;
		flex-wrap: wrap;
	}
	.statgrid div {
		display: flex;
		flex-direction: column;
	}
	.statgrid span {
		color: #777;
		font-size: 0.75rem;
	}
	.statgrid b {
		font-size: 1.1rem;
	}
	.compare {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	.compare.solo {
		grid-template-columns: 1fr;
	}
	.compare .panel {
		margin-bottom: 1rem;
		min-width: 0;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.82rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.25rem 0.6rem;
		border-bottom: 1px solid #eee;
		white-space: nowrap;
	}
	th {
		color: #666;
		font-weight: 600;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.muted {
		color: #888;
	}
	.small {
		font-size: 0.8rem;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	a {
		color: #2563eb;
	}
</style>
