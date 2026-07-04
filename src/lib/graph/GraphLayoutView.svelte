<script lang="ts">
	// Reference-anchored "stringy" graph layout (ported from mini-web-viz-for-gfa).
	// Each segment is drawn as a strand whose length ∝ its sequence length; the
	// reference/backbone path is pinned to a straight horizontal line and variant
	// bubbles relax locally around it.
	//
	// The force layout runs in a Web Worker (layout.worker.ts) so a dense subgraph
	// with thousands of tiny SNP nodes doesn't freeze the tab. For large graphs a
	// simplification pass collapses small non-reference bubbles and drops
	// sequences (see gfaToGraph) before layout.
	import { onDestroy } from 'svelte';
	import type { Gfa } from '../gfa';
	import { gfaToGraph } from './gfaToGraph';
	import type { LayoutResult } from './forceLayout';
	import type { LayoutRequest, LayoutResponse } from './layout.worker';
	import GraphCanvas from './GraphCanvas.svelte';

	let { gfa, referenceSample }: { gfa: Gfa; referenceSample: string } = $props();

	// Above this node count the raw graph is dense enough that a full layout is
	// slow and the tiny-SNP clutter hides the structural variation — so collapse
	// small bubbles and drop sequences by default.
	const AUTO_SIMPLIFY_SEGMENTS = 1500;
	const AUTO_PRUNE_BP = 10;

	let pruneBelow = $state(0);
	let dropSequences = $state(false);
	let autoApplied = $state(false);
	let selected = $state<string | null>(null);

	// One-time auto-tune when a new graph arrives.
	$effect(() => {
		const n = gfa.segments.size;
		selected = null;
		if (n > AUTO_SIMPLIFY_SEGMENTS) {
			pruneBelow = AUTO_PRUNE_BP;
			dropSequences = true;
			autoApplied = true;
		} else {
			pruneBelow = 0;
			dropSequences = false;
			autoApplied = false;
		}
	});

	const adapted = $derived(gfaToGraph(gfa, { referenceSample, pruneBelow, dropSequences }));

	// --- layout worker ---
	let worker: Worker | null = null;
	let reqId = 0;
	let layout = $state<LayoutResult | null>(null);
	let ms = $state(0);
	let computing = $state(false);

	function ensureWorker(): Worker {
		if (!worker) {
			worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
			worker.onmessage = (ev: MessageEvent<LayoutResponse>) => {
				if (ev.data.id !== reqId) return; // superseded by a newer request
				layout = ev.data.layout;
				ms = ev.data.ms;
				computing = false;
			};
		}
		return worker;
	}

	// Kick off a (re)layout whenever the adapted graph changes.
	$effect(() => {
		const graph = adapted.graph;
		const id = ++reqId;
		computing = true;
		const w = ensureWorker();
		w.postMessage({ id, graph } satisfies LayoutRequest);
	});

	onDestroy(() => worker?.terminate());

	const selectedLen = $derived(selected ? (gfa.segments.get(selected)?.length ?? null) : null);
</script>

<div class="wrap">
	<div class="head">
		<label class="opt">
			collapse bubbles ≤
			<input type="number" min="0" max="10000" step="1" bind:value={pruneBelow} /> bp
		</label>
		<label class="opt">
			<input type="checkbox" bind:checked={dropSequences} /> drop sequences
		</label>
		<span class="spacer"></span>
		<span class="muted">
			{adapted.keptSegments.toLocaleString()} nodes
			{#if adapted.droppedSegments > 0}
				· <b>{adapted.droppedSegments.toLocaleString()}</b> collapsed
			{/if}
			{#if computing}
				· <span class="computing">computing…</span>
			{:else if layout}
				· layout {ms} ms
			{/if}
		</span>
	</div>

	{#if autoApplied}
		<p class="notice">
			Large subgraph ({gfa.segments.size.toLocaleString()} nodes) — auto-collapsed non-reference
			bubbles ≤ {AUTO_PRUNE_BP} bp and dropped sequences to keep the layout responsive. Set “collapse
			bubbles” to 0 to see the full graph.
		</p>
	{/if}

	<div class="stage">
		{#if layout}
			<GraphCanvas {layout} onSelectSegment={(id) => (selected = id)} />
		{/if}
		{#if computing}
			<div class="overlay"><span>computing layout…</span></div>
		{/if}
	</div>

	<div class="foot">
		{#if selected}
			<span>selected <code>{selected}</code>{#if selectedLen != null} · {selectedLen.toLocaleString()} bp{/if}</span>
		{:else}
			<span class="muted">click a strand to select · plain scroll pans · ⌘/ctrl-scroll (or pinch) zooms</span>
		{/if}
		<span class="spacer"></span>
		<span class="legend"><span class="sw backbone"></span> reference backbone</span>
		<span class="legend"><span class="sw grad"></span> more haplotypes →</span>
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.head,
	.foot {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
	}
	.head .spacer,
	.foot .spacer {
		flex: 1;
	}
	.opt {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.opt input[type='number'] {
		width: 4.5rem;
		font: inherit;
		padding: 0.15rem 0.35rem;
		border: 1px solid #ccc;
		border-radius: 5px;
	}
	.computing {
		color: #2563eb;
	}
	.stage {
		position: relative;
		height: 460px;
		border: 1px solid #eee;
		border-radius: 8px;
		overflow: hidden;
		background: #0b0d12;
	}
	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #9aa3b2;
		background: rgba(11, 13, 18, 0.55);
		font-size: 0.9rem;
	}
	.notice {
		color: #92400e;
		background: #fffbeb;
		border: 1px solid #fde68a;
		padding: 0.5rem 0.7rem;
		border-radius: 6px;
		font-size: 0.82rem;
		margin: 0;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.sw {
		display: inline-block;
		width: 22px;
		height: 5px;
		border-radius: 2px;
	}
	.sw.backbone {
		background: #f2f4f8;
		border: 1px solid #ccc;
	}
	.sw.grad {
		width: 60px;
		background: linear-gradient(90deg, rgb(255, 214, 10), rgb(214, 30, 30));
	}
	.muted {
		color: #888;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
</style>
