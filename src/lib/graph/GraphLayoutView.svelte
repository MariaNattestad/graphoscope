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
	import { transcriptsInRange, representativeTranscripts, type Transcript } from '../geneTrack';
	import type { RefKey } from '../genes';

	let {
		gfa,
		referenceSample,
		refKey,
		discoAvailable = false,
		discoLoading = false,
		onRequestDiscoGraph
	}: {
		gfa: Gfa;
		referenceSample: string;
		refKey?: RefKey;
		/** Whether the parent can supply the full (unsimplified) graph — the one that
		 * still carries every haplotype walk — so disco-walks has anything to trace. */
		discoAvailable?: boolean;
		/** Parent is currently fetching that full graph. */
		discoLoading?: boolean;
		/** Ask the parent to load + show the full-walk graph (for disco-walks). */
		onRequestDiscoGraph?: () => void;
	} = $props();

	// Keep all non-reference bubbles on one side (above the reference line). This
	// halves the vertical spread and, more importantly, leaves the space below the
	// backbone free for the gene track. On by default; the toggle restores the
	// symmetric two-sided layout.
	let bubblesAbove = $state(true);

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
		// In reduced mode the individual walks are aggregated away, so we can't
		// name them — but the reducer counts how many begin and end at each node
		// (`WS`/`WE` tags), which is the part that actually flags an artifact.
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
	// Reduced mode: counts from the `WS`/`WE` tags on the selected segment.
	const endpointCounts = $derived.by(() => {
		if (!gfa.reduced || !selected) return null;
		const seg = gfa.segments.get(selected);
		const s = seg?.walkStarts ?? 0;
		const e = seg?.walkEnds ?? 0;
		return s === 0 && e === 0 ? null : { starts: s, ends: e };
	});

	const adapted = $derived(gfaToGraph(gfa, { referenceSample }));

	// --- disco-walks 🪩 -----------------------------------------------------------
	// Load every walk on top of the layout and cycle a spotlight through them, one
	// per tick — a moving highlight that traces each walk's path through the graph.
	// The main graph is served reduced (walks aggregated into coverage tags), so we
	// can only do this on the unsimplified graph, which still carries the individual
	// W-lines. When the user starts disco while the reduced graph is showing, we ask
	// the parent to swap in the full-walk graph and start as soon as it arrives.
	const DISCO_INTERVAL_MS = 100;

	interface DiscoWalk {
		steps: { id: string; orient: '+' | '-' }[];
	}
	const discoWalks = $derived.by((): DiscoWalk[] => {
		const out: DiscoWalk[] = [];
		// Collapse walks that trace the same segments. At a repetitive/hypervariable
		// locus (e.g. HLA-A) gbz-base fragments haplotypes into many identical short
		// walk records; left in, the cycle spends seconds re-highlighting the same
		// handful of nodes, which reads as one node "blinking" forever. Direction
		// doesn't change the drawn line, so normalise a walk and its reverse to one
		// key and keep only the first walk with each distinct trace.
		const seen = new Set<string>();
		for (const w of gfa.walks) {
			if (w.steps.length < 2) continue; // a single node isn't a path to trace
			const ids = w.steps.map((s) => s.id);
			const fwd = ids.join('>');
			let rev = '';
			for (let i = ids.length - 1; i >= 0; i--) rev += (rev ? '>' : '') + ids[i];
			const key = fwd < rev ? fwd : rev;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ steps: w.steps });
		}
		return out;
	});
	// The full graph carries real walks; the reduced one doesn't, so disco can only
	// run once we're looking at the unsimplified graph.
	const canDiscoNow = $derived(!gfa.reduced && discoWalks.length > 0);

	let disco = $state(false);
	let pendingDisco = $state(false);
	let discoIndex = $state(0);

	function toggleDisco() {
		if (disco) {
			disco = false;
			return;
		}
		if (canDiscoNow) {
			discoIndex = 0;
			disco = true;
			trackEvent('widget_interact', { widget: 'graph_layout', action: 'disco_walks_start' });
			return;
		}
		if (discoLoading || pendingDisco) return;
		// Need the full-walk graph first; the parent will swap it in.
		pendingDisco = true;
		trackEvent('widget_interact', { widget: 'graph_layout', action: 'disco_walks_start' });
		onRequestDiscoGraph?.();
	}

	// Start disco the moment the full-walk graph arrives after a pending request.
	$effect(() => {
		if (pendingDisco && canDiscoNow) {
			pendingDisco = false;
			discoIndex = 0;
			disco = true;
		}
	});

	// The full-graph load finished (or failed) without producing walks — give up
	// on the pending start rather than showing "loading" forever.
	$effect(() => {
		if (pendingDisco && !discoLoading && !canDiscoNow) pendingDisco = false;
	});

	// If the walks disappear (e.g. a new query reverted to the reduced graph), stop.
	$effect(() => {
		if (disco && !canDiscoNow) disco = false;
	});

	// The cycling timer: advance one walk per tick while disco is on.
	$effect(() => {
		if (!disco || discoWalks.length === 0) return;
		const timer = setInterval(() => {
			discoIndex = (discoIndex + 1) % discoWalks.length;
		}, DISCO_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	const currentDiscoWalk = $derived(
		disco && discoWalks.length > 0 ? discoWalks[discoIndex % discoWalks.length] : null
	);
	const discoPath = $derived(currentDiscoWalk?.steps ?? null);
	// Spin the hue with the cycle so each walk gets its own disco color.
	const discoColor = $derived(`hsl(${(discoIndex * 47) % 360}, 95%, 62%)`);
	// Show the button whenever disco is either already possible or loadable.
	const showDiscoButton = $derived(canDiscoNow || discoAvailable || disco || pendingDisco);

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

	// The reference genomic span this subgraph covers — the window to fetch genes
	// for. Derived from the reference coordinates so it always matches what the
	// backbone actually shows.
	const locusWindow = $derived.by(() => {
		let contig: string | null = null;
		let start = Infinity;
		let end = -Infinity;
		for (const c of refCoords.values()) {
			contig = c.contig;
			if (c.start < start) start = c.start;
			if (c.end > end) end = c.end;
		}
		return contig && Number.isFinite(start) ? { contig, start, end } : null;
	});

	// Gene models for the track under the backbone, fetched from UCSC bigBed (same
	// source as the arc view). Best-effort: on any failure the track just stays
	// empty and the graph is unaffected.
	let genes = $state<Transcript[]>([]);
	$effect(() => {
		const win = locusWindow;
		const key = refKey;
		if (!win || !key) {
			genes = [];
			return;
		}
		let cancelled = false;
		transcriptsInRange(key, win.contig, win.start, win.end)
			.then((t) => {
				if (!cancelled) genes = representativeTranscripts(t);
			})
			.catch(() => {
				if (!cancelled) genes = [];
			});
		return () => {
			cancelled = true;
		};
	});

	// Past this node count the full-quality layout takes minutes, so switch to a
	// rough one automatically rather than making people wait or choose. Below it,
	// quality is cheap and rough mode looked wrong on small graphs — which is why
	// it isn't offered as a manual toggle.
	const LARGE_LAYOUT_NODE_THRESHOLD = 2000;
	const roughLayout = $derived(adapted.keptSegments > LARGE_LAYOUT_NODE_THRESHOLD);

	// Only warn "this can take a while" for genuinely heavy layouts. This is a much
	// higher bar than the rough-layout switch above: rough mode makes even a
	// ~10k-node graph lay out in a handful of seconds (measured ~6s on a 9,892-node
	// fixture), so the warning must not fire the moment rough mode kicks in at
	// 2,000 — it should only appear near the top of the renderable range
	// (MAX_UNSIMPLIFIED_NODES is 25,000), where even the rough layout can run long.
	const LARGE_LAYOUT_WARNING_THRESHOLD = 15000;
	const showSlowLayoutWarning = $derived(adapted.keptSegments > LARGE_LAYOUT_WARNING_THRESHOLD);

	// --- layout worker ---
	let worker: Worker | null = null;
	let reqId = 0;
	// `$state.raw`, not `$state`: the layout is a large graph structure (a
	// `nodesById` Map of thousands of nodes, the chains array, every SimNode) that
	// GraphCanvas reads hundreds of thousands of times per draw. Plain `$state`
	// deep-proxies all of it, so every one of those reads pays Svelte's proxy-trap
	// cost — enough to drop disco-walks (which redraws ~10×/s) to a few FPS. We only
	// ever reassign `layout` wholesale (never mutate its innards), so raw state is
	// both correct and dramatically faster: the canvas iterates plain objects.
	let layout = $state.raw<LayoutResult | null>(null);
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
		// Rough mode collapses each segment to one simulation node (instead of up
		// to 60 sub-nodes for a smooth strand), cuts the iterations, and drops the
		// per-link bend nodes — which is where nearly all the time goes on a big
		// graph (62.5s -> 6.0s measured on a 9,892-node fixture).
		const options = roughLayout
			? {
					referenceSample,
					maxEdgesPerSegment: 1,
					targetTotalSubNodes: 400,
					iterations: 60,
					bendNodes: false,
					bubblesAbove
				}
			: { referenceSample, bubblesAbove };
		w.postMessage({ id, graph: $state.snapshot(graph), options } satisfies LayoutRequest);
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
		<label class="opt" title="Keep variant bubbles on one side, freeing the space below the reference line">
			<input type="checkbox" bind:checked={bubblesAbove} /> one-sided
		</label>
		{#if computing}
			<span class="computing">computing…</span>
		{:else if layout}
			<span class="muted">· layout {ms} ms</span>
		{/if}
		{#if roughLayout}
			<span class="rough" title="Too many nodes for the full-quality layout; positions are approximate">
				rough layout
			</span>
		{/if}
		<span class="spacer"></span>
		{#if showDiscoButton}
			<button
				class="disco"
				class:on={disco}
				onclick={toggleDisco}
				disabled={discoLoading || pendingDisco}
				title="Spotlight every haplotype walk in turn, tracing each one through the graph (uses the full unsimplified graph)"
			>
				{#if discoLoading || pendingDisco}
					🪩 loading walks…
				{:else if disco}
					🪩 stop · walk {(discoIndex % discoWalks.length) + 1}/{discoWalks.length}
				{:else}
					🪩 disco-walks
				{/if}
			</button>
		{/if}
	</div>

	<div class="stage">
		{#if layout}
			<GraphCanvas
				{layout}
				{refCoords}
				{genes}
				{discoPath}
				{discoColor}
				discoActive={disco}
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
					{#if showSlowLayoutWarning}
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

	{#if endpointCounts}
		<div class="endpoints">
			<span class="hint muted">
				a walk dead-ending here (not reaching a bubble's far side or the subgraph edge) is often an
				artifact worth checking
			</span>
			{#if endpointCounts.starts > 0}
				<div class="erow">
					<span class="etag start"
						>{endpointCounts.starts.toLocaleString()} walk{endpointCounts.starts === 1 ? '' : 's'} start
						here</span
					>
				</div>
			{/if}
			{#if endpointCounts.ends > 0}
				<div class="erow">
					<span class="etag end"
						>{endpointCounts.ends.toLocaleString()} walk{endpointCounts.ends === 1 ? '' : 's'} end here</span
					>
				</div>
			{/if}
		</div>
	{:else if selected && endpoints.length > 0}
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
	.foot .spacer,
	.head .spacer {
		flex: 1;
	}
	.computing {
		color: #2563eb;
	}
	.disco {
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
		border: 1px solid #d1c4f0;
		background: #f6f2ff;
		color: #5b21b6;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		white-space: nowrap;
	}
	.disco:hover:not(:disabled) {
		background: #efe7ff;
	}
	.disco.on {
		border-color: #7c3aed;
		background: linear-gradient(90deg, #7c3aed, #db2777);
		color: #fff;
		box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.3);
	}
	.disco:disabled {
		opacity: 0.7;
		cursor: default;
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
