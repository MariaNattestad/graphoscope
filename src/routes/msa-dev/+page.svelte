<script lang="ts">
	// DEV-ONLY, intentionally unlinked from the app. A harness for iterating on the
	// MSA base-alignment view: pick an example graph and a node, and the alignment
	// stays open so changes are visible immediately. Not part of the product nav.
	import { parseGfa, type Gfa } from '$lib/gfa';
	import { ALL_FIXTURES, type Fixture } from '$lib/graph/fixtures';
	import MsaPanel from '$lib/graph/MsaPanel.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';

	let selectedId = $state(ALL_FIXTURES[0].id);
	const fixture = $derived<Fixture>(ALL_FIXTURES.find((f) => f.id === selectedId) ?? ALL_FIXTURES[0]);
	// Held raw so the walk step objects stay plain (the layout worker structured-
	// clones them; a proxied graph throws DataCloneError). See playground note.
	let gfa = $state.raw<Gfa>(parseGfa(ALL_FIXTURES[0].gfaText));

	let selectedNode = $state<string | null>(null);
	let lightMode = $state(false);
	let showGraph = $state(false);

	const nodeIds = $derived([...gfa.segments.keys()]);

	// Pick a node worth looking at: the non-reference (alt) node the most walks pass
	// through — the busiest variant site — else the middle of the reference walk.
	function pickInteresting(g: Gfa, referenceSample?: string): string | null {
		const refWalk =
			g.walks.find((w) => w.sample === referenceSample) ??
			g.walks.find((w) => w.kind !== 'synthetic') ??
			g.walks[0];
		const refSet = new Set(refWalk?.steps.map((s) => s.id));
		const count = new Map<string, number>();
		for (const w of g.walks) {
			if (w.kind === 'synthetic') continue;
			const seen = new Set<string>();
			for (const s of w.steps) {
				if (refSet.has(s.id) || seen.has(s.id)) continue;
				seen.add(s.id);
				count.set(s.id, (count.get(s.id) ?? 0) + 1);
			}
		}
		let best: string | null = null;
		let bestN = 0;
		for (const [id, n] of count) if (n > bestN) ((bestN = n), (best = id));
		if (best) return best;
		// Linear graph: middle backbone node.
		if (refWalk && refWalk.steps.length) return refWalk.steps[Math.floor(refWalk.steps.length / 2)].id;
		return nodeIds[0] ?? null;
	}

	$effect(() => {
		const parsed = parseGfa(fixture.gfaText);
		gfa = parsed;
		selectedNode = pickInteresting(parsed, fixture.referenceSample);
	});

	const walkCount = $derived(gfa.walks.filter((w) => w.kind !== 'synthetic').length);
</script>

<svelte:head><title>MSA dev harness</title></svelte:head>

<main class:light={lightMode}>
	<header>
		<h1>MSA base-alignment — dev harness</h1>
		<p class="sub">Unlinked development page. Iterate on the base-alignment view against real & synthetic loci.</p>
	</header>

	<section class="ctl">
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
			Node
			<input list="node-ids" bind:value={selectedNode} placeholder="segment id" />
			<datalist id="node-ids">
				{#each nodeIds.slice(0, 2000) as id (id)}
					<option value={id}></option>
				{/each}
			</datalist>
		</label>
		<button onclick={() => (selectedNode = pickInteresting(gfa, fixture.referenceSample))}>
			busiest variant
		</button>

		<label class="chk"><input type="checkbox" bind:checked={lightMode} /> light</label>
		<label class="chk"><input type="checkbox" bind:checked={showGraph} /> show graph</label>

		<span class="stat">{gfa.segments.size.toLocaleString()} nodes · {walkCount.toLocaleString()} walks</span>
	</section>
	<p class="desc">{fixture.description}</p>

	{#if showGraph}
		<div class="graph-embed">
			<GraphLayoutView {gfa} referenceSample={fixture.referenceSample} />
		</div>
	{/if}

	<div class="msa-embed">
		{#key selectedId}
			<MsaPanel {gfa} referenceSample={fixture.referenceSample} selectedSegId={selectedNode} {lightMode} />
		{/key}
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		background: #0b0d12;
		color: #e6ebf5;
	}
	main {
		padding: 1.2rem 1.4rem 3rem;
		max-width: 1500px;
		margin: 0 auto;
	}
	main.light {
		background: #fff;
		color: #1a1a1a;
	}
	h1 {
		margin: 0 0 0.2rem;
		font-size: 1.3rem;
	}
	.sub {
		margin: 0 0 1rem;
		opacity: 0.6;
		font-size: 0.85rem;
	}
	.ctl {
		display: flex;
		gap: 1.1rem;
		align-items: center;
		flex-wrap: wrap;
		padding: 0.7rem 0.9rem;
		border: 1px solid rgba(140, 155, 180, 0.2);
		border-radius: 10px;
	}
	label {
		font-size: 0.82rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.chk {
		gap: 0.3rem;
	}
	select,
	input {
		font: inherit;
		font-size: 0.82rem;
		padding: 0.3rem 0.45rem;
		border-radius: 6px;
		border: 1px solid rgba(140, 155, 180, 0.35);
		background: transparent;
		color: inherit;
	}
	select option,
	select optgroup {
		color: #111;
	}
	input {
		width: 12rem;
	}
	button {
		font: inherit;
		font-size: 0.8rem;
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		border: 1px solid rgba(140, 155, 180, 0.35);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	button:hover {
		background: rgba(140, 155, 180, 0.14);
	}
	.stat {
		margin-left: auto;
		font-size: 0.8rem;
		opacity: 0.7;
	}
	.desc {
		margin: 0.6rem 0.2rem 1rem;
		font-size: 0.82rem;
		opacity: 0.7;
	}
	.graph-embed {
		height: 720px;
		border: 1px solid rgba(140, 155, 180, 0.2);
		border-radius: 10px;
		overflow: hidden;
		margin-bottom: 1rem;
	}
	.msa-embed {
		height: 620px;
		border: 1px solid rgba(140, 155, 180, 0.25);
		border-radius: 10px;
		overflow: hidden;
	}
</style>
