<script lang="ts">
	// Simplification playground: pick an example graph, tweak the threshold, and
	// compare the original against the simplified graph side by side.
	//
	// The simplification here is not a demo reimplementation — it runs the actual
	// `query.wasm`, in its `--gfa` mode, over the fixture. So this page and a live
	// locus query go through the same binary, and the fixtures it shows are the
	// same files `crates/reduce/src/tests.rs` asserts on.
	import { onMount } from 'svelte';
	import { parseGfa, type Gfa } from '$lib/gfa';
	import { ALL_FIXTURES, type Fixture } from '$lib/graph/fixtures';
	import type { ReduceRequest, ReduceResult } from '$lib/gfaReduce.worker';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { base } from '$app/paths';

	let selectedId = $state(ALL_FIXTURES[0].id);
	let maxVariant = $state(50);

	const fixture = $derived<Fixture>(
		ALL_FIXTURES.find((f) => f.id === selectedId) ?? ALL_FIXTURES[0]
	);
	const parsed = $derived(parseGfa(fixture.gfaText));

	// The reduced GFA text itself, capped for display.
	let reducedText = $state('');
	const REDUCED_LINES = 60;
	const reducedPreview = $derived(
		reducedText.split('\n').slice(0, REDUCED_LINES).join('\n') +
			(reducedText.split('\n').length > REDUCED_LINES ? '\n…' : '')
	);

	let reduced = $state<Gfa | null>(null);
	let running = $state(false);
	let error = $state<string | null>(null);
	let elapsedMs = $state<number | null>(null);

	let worker: Worker | null = null;
	let nextId = 1;
	let pending = new Map<number, (r: ReduceResult) => void>();

	onMount(() => {
		worker = new Worker(new URL('$lib/gfaReduce.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (ev: MessageEvent<ReduceResult>) => {
			const cb = pending.get(ev.data.id);
			if (cb) {
				pending.delete(ev.data.id);
				cb(ev.data);
			}
		};
		return () => worker?.terminate();
	});

	// Re-reduce whenever the fixture or threshold changes. Only the newest request
	// is allowed to write the result, so a slow fixture can't overwrite a newer one.
	let latest = 0;
	$effect(() => {
		const text = fixture.gfaText;
		const mv = maxVariant;
		if (!worker) return;
		const id = nextId++;
		latest = id;
		running = true;
		error = null;
		const req: ReduceRequest = {
			id,
			gfaText: text,
			maxVariant: mv,
			wasmUrl: `${base}/query.wasm`
		};
		new Promise<ReduceResult>((resolve) => {
			pending.set(id, resolve);
			worker!.postMessage(req);
		}).then((result) => {
			if (id !== latest) return;
			running = false;
			elapsedMs = result.elapsedMs ?? null;
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
				reduced = null;
				reducedText = '';
				return;
			}
			reducedText = result.gfa ?? '';
			reduced = parseGfa(reducedText);
		});
	});

	const stats = $derived(reduced?.reduced ?? null);

</script>

<main>
	<header>
		<h1>Simplification playground</h1>
		<p class="sub">
			Reference-guided small-variant popping + unchop, run on example graphs by the same
			<code>query.wasm</code> the locus browser uses — not a separate demo implementation. The
			constructed graphs each isolate one thing the algorithm has to get right, and the numbers below
			are pinned in <code>crates/reduce/src/tests.rs</code>.
			<a href="{base}/">← back to the browser</a>
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
		</div>
		<p class="desc">{fixture.description}</p>
	</section>

	<section class="panel">
		{#if error}
			<pre class="err">{error}</pre>
		{:else if stats}
			<div class="statgrid">
				<div><span>segments</span><b>{stats.segmentsBefore} → {stats.segmentsAfter}</b></div>
				<div><span>links</span><b>{stats.linksBefore} → {stats.linksAfter}</b></div>
				<div><span>sites collapsed</span><b>{stats.sites}</b></div>
				<div><span>nodes removed</span><b>{stats.nodesRemoved}</b></div>
				<div><span>SNPs</span><b>{stats.snpCount}</b></div>
				<div><span>alt bp condensed</span><b>{stats.basesRemoved}</b></div>
				<div><span>unchop merges</span><b>{stats.unchopMerges}</b></div>
			</div>
			{#if fixture.kind === 'synthetic' && fixture.expect}
				{@const e = fixture.expect}
				{@const ok =
					stats.sites === e.sites &&
					stats.nodesRemoved === e.nodesRemoved &&
					stats.snpCount === e.snpCount &&
					stats.basesRemoved === e.basesRemoved}
				<p class="muted small">
					<span class={ok ? 'pass' : 'fail'}>{ok ? '✓ matches' : '✗ differs from'}</span> the pinned
					expectation: {e.sites} sites · {e.nodesRemoved} nodes · {e.snpCount} SNPs · {e.basesRemoved}
					alt bp
					<span class="muted">(also asserted in crates/reduce/src/tests.rs)</span>
				</p>
			{/if}
			<p class="muted small">
				Reduced by <code>query.wasm</code> — the same binary the locus browser runs{#if elapsedMs !=
					null}, in {elapsedMs} ms{/if}
			</p>
		{:else}
			<p class="muted small">reducing…</p>
		{/if}
	</section>

	<div class="compare">
		<section class="panel">
			<h2 class="panel-title">Original · {parsed.segments.size} nodes</h2>
			<GraphLayoutView gfa={parsed} referenceSample={fixture.referenceSample} />
		</section>
		<section class="panel">
			<h2 class="panel-title">
				Simplified · {reduced ? reduced.segments.size : '…'} nodes
			</h2>
			{#if reduced}
				<GraphLayoutView gfa={reduced} referenceSample={fixture.referenceSample} />
			{:else}
				<p class="muted small">{running ? 'reducing…' : 'no result'}</p>
			{/if}
		</section>
	</div>

	{#if reduced}
		<section class="panel">
			<h2 class="panel-title">Reduced GFA</h2>
			<p class="muted small">
				What the wasm returns, and what the browser actually parses: segments and links carrying
				<code>WC</code> walk-coverage tags, an <code>X</code> line of locus counts, and only the
				reference <code>W</code> line — every other haplotype walk has been counted into those tags
				and dropped.
			</p>
			<pre class="rawtext">{reducedPreview}</pre>
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
	.compare .panel {
		margin-bottom: 1rem;
		min-width: 0;
	}
	.pass {
		color: #15803d;
		font-weight: 600;
	}
	.fail {
		color: #b91c1c;
		font-weight: 600;
	}
	.err {
		color: #b91c1c;
		white-space: pre-wrap;
		font-size: 0.8rem;
		margin: 0;
	}
	.rawtext {
		background: #0f172a;
		color: #cbd5e1;
		padding: 0.8rem;
		border-radius: 8px;
		max-height: 340px;
		overflow: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		line-height: 1.45;
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
