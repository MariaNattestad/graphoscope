<script lang="ts">
	// Reference-anchored "stringy" graph layout (ported from mini-web-viz-for-gfa).
	// Each segment is drawn as a strand whose length ∝ its sequence length; the
	// reference/backbone path is pinned to a straight horizontal line and variant
	// bubbles relax locally around it. The force layout runs in a Web Worker so a
	// dense subgraph never freezes the tab. Graph simplification happens upstream,
	// so this component just lays out and draws whatever graph it's given.
	import { onDestroy } from 'svelte';
	import type { Gfa } from '../gfa';
	import { gfaToGraph } from './gfaToGraph';
	import type { LayoutResult } from './forceLayout';
	import type { LayoutRequest, LayoutResponse } from './layout.worker';
	import GraphCanvas from './GraphCanvas.svelte';
	import { trackEvent } from '../analytics';

	let { gfa, referenceSample }: { gfa: Gfa; referenceSample: string } = $props();

	let selected = $state<string | null>(null);

	$effect(() => {
		gfa;
		selected = null;
	});

	// Walks that start or end exactly at the selected node — the tell for a
	// haplotype fragment/artifact: a walk that dead-ends inside the graph rather
	// than reaching the subgraph boundary or the far side of a bubble. A walk's
	// `start`/`end` fields are the W-line's own SeqStart/SeqEnd, i.e. its length
	// within this record (0 for anonymous haplotypes), so `end - start` is the
	// walk's real bp span — the same number you'd find by hand in the raw GFA.
	interface WalkEndpoint {
		label: string;
		length: number;
		role: 'start' | 'end' | 'both';
	}
	function walkEndpointsAt(nodeId: string): WalkEndpoint[] {
		// Needs per-haplotype walks; in reduced mode those are aggregated away, so
		// there's nothing meaningful to show (only the reference walk remains).
		if (gfa.reduced) return [];
		const out: WalkEndpoint[] = [];
		for (const w of gfa.walks) {
			if (w.steps.length === 0) continue;
			const startsHere = w.steps[0].id === nodeId;
			const endsHere = w.steps[w.steps.length - 1].id === nodeId;
			if (!startsHere && !endsHere) continue;
			const label = w.sample === 'unknown' ? `hap ${w.hapIndex}` : `${w.sample}#${w.hapIndex}`;
			const length = w.end - w.start;
			out.push({ label, length, role: startsHere && endsHere ? 'both' : startsHere ? 'start' : 'end' });
		}
		return out;
	}
	const endpoints = $derived(selected ? walkEndpointsAt(selected) : []);
	const starts = $derived(endpoints.filter((e) => e.role === 'start' || e.role === 'both'));
	const ends = $derived(endpoints.filter((e) => e.role === 'end' || e.role === 'both'));

	const adapted = $derived(gfaToGraph(gfa, { referenceSample }));

	// Reference genomic coordinates for each reference segment. Walk the reference
	// sample's path (fall back to the first walk, matching gfaToGraph) and
	// accumulate segment lengths from the walk's own genomic start. After
	// simplification a reference node may be an unchopped merge of several original
	// nodes — its [start, end) here is the full merged span. Passed to the canvas
	// so backbone nodes can be labelled with their coordinates.
	interface RefCoord {
		contig: string;
		start: number;
		end: number;
	}
	const refCoords = $derived.by(() => {
		const map = new Map<string, RefCoord>();
		const refWalks = gfa.walks.filter((w) => w.sample === referenceSample);
		const ref = refWalks.length > 0 ? refWalks[0] : gfa.walks[0];
		if (!ref) return map;
		let cursor = ref.start ?? 0;
		for (const step of ref.steps) {
			const len = gfa.segments.get(step.id)?.length ?? 0;
			// If a segment recurs on the reference walk, keep the first occurrence's
			// coordinate (the layout draws each segment once anyway).
			if (!map.has(step.id)) map.set(step.id, { contig: ref.seqId, start: cursor, end: cursor + len });
			cursor += len;
		}
		return map;
	});

	// Past this node count, layout time stops scaling gently — e.g. a
	// reference-only reduced-mode graph on a large/repetitive locus (tens of
	// thousands of nodes) has been observed taking several minutes, not
	// seconds. Below this, graphs typically lay out in well under 20s.
	const LARGE_LAYOUT_NODE_THRESHOLD = 2000;

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

	// Kick off a (re)layout whenever the graph changes.
	$effect(() => {
		const graph = adapted.graph;
		const id = ++reqId;
		computing = true;
		const w = ensureWorker();
		// `graph` traces back into `gfa`, which is (or is derived from) `$state`
		// — Svelte 5 deep-reactivity wraps its nested objects/arrays in Proxies,
		// and `postMessage`'s structured-clone algorithm can't clone a Proxy
		// (throws DataCloneError). simplify.ts and gfaToGraph.ts deliberately
		// share step objects internally rather than copying them (a large
		// locus can have millions), so nothing upstream de-proxies them for us
		// — this snapshot is the one place that must, since it's the one place
		// with a hard structured-clone requirement.
		w.postMessage({ id, graph: $state.snapshot(graph), options: { referenceSample } } satisfies LayoutRequest);
	});

	onDestroy(() => worker?.terminate());

	const selectedLen = $derived(selected ? (gfa.segments.get(selected)?.length ?? null) : null);
	const selectedCoord = $derived(selected ? (refCoords.get(selected) ?? null) : null);
	function fmtCoord(c: RefCoord): string {
		return `${c.contig}:${c.start.toLocaleString()}–${c.end.toLocaleString()}`;
	}
</script>

<div class="wrap">
	<div class="head">
		<span class="muted">{adapted.keptSegments.toLocaleString()} nodes</span>
		{#if computing}
			<span class="computing">computing…</span>
		{:else if layout}
			<span class="muted">· layout {ms} ms</span>
		{/if}
	</div>

	<div class="stage">
		{#if layout}
			<GraphCanvas
				{layout}
				{refCoords}
				onSelectSegment={(id) => {
					selected = id;
					if (id) trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_node' });
				}}
			/>
		{/if}
		{#if computing}
			<div class="overlay">
				<span>
					computing layout…
					{#if adapted.keptSegments > LARGE_LAYOUT_NODE_THRESHOLD}
						<br />
						<span class="overlay-warning">
							{adapted.keptSegments.toLocaleString()} nodes is a lot — this can take a few minutes on
							a large or repetitive locus. Still working, not stuck.
						</span>
					{/if}
				</span>
			</div>
		{/if}
	</div>

	<div class="foot">
		{#if selected}
			<span>selected <code>{selected}</code>{#if selectedLen != null} · {selectedLen.toLocaleString()} bp{/if}{#if selectedCoord} · <span class="coord">{fmtCoord(selectedCoord)}</span>{/if}</span>
		{:else}
			<span class="muted">click a strand to select · plain scroll pans · ⌘/ctrl-scroll (or pinch) zooms</span>
		{/if}
		<span class="spacer"></span>
		<span class="legend"><span class="sw backbone"></span> reference backbone (coords shown)</span>
		<span class="legend"><span class="sw grad"></span> more walks through node →</span>
	</div>

	{#if selected && endpoints.length > 0}
		<div class="endpoints">
			<span class="hint muted">
				a walk dead-ending here (not reaching a bubble's far side or the subgraph edge) is often an
				artifact worth checking
			</span>
			{#if starts.length > 0}
				<div class="erow">
					<span class="etag start">{starts.length} walk{starts.length === 1 ? '' : 's'} start here</span>
					{#each starts.slice(0, 8) as e (e.label)}
						<span class="chip">{e.label} · {e.length.toLocaleString()}bp</span>
					{/each}
					{#if starts.length > 8}<span class="muted">+{starts.length - 8} more</span>{/if}
				</div>
			{/if}
			{#if ends.length > 0}
				<div class="erow">
					<span class="etag end">{ends.length} walk{ends.length === 1 ? '' : 's'} end here</span>
					{#each ends.slice(0, 8) as e (e.label)}
						<span class="chip">{e.label} · {e.length.toLocaleString()}bp</span>
					{/each}
					{#if ends.length > 8}<span class="muted">+{ends.length - 8} more</span>{/if}
				</div>
			{/if}
		</div>
	{/if}
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
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
	}
	.foot .spacer {
		flex: 1;
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
		text-align: center;
		color: #9aa3b2;
		background: rgba(11, 13, 18, 0.55);
		font-size: 0.9rem;
		padding: 0 1.5rem;
	}
	.overlay-warning {
		display: inline-block;
		margin-top: 0.4rem;
		max-width: 32rem;
		color: #fbbf24;
		font-size: 0.78rem;
		line-height: 1.4;
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
	.coord {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: #2563eb;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	.endpoints {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.8rem;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 6px;
		padding: 0.5rem 0.7rem;
	}
	.endpoints .hint {
		font-size: 0.76rem;
	}
	.erow {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.etag {
		font-weight: 600;
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
		white-space: nowrap;
	}
	.etag.start {
		background: #dcfce7;
		color: #166534;
	}
	.etag.end {
		background: #fee2e2;
		color: #991b1b;
	}
	.chip {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 0.05rem 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.74rem;
	}
</style>
