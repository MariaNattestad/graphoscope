<script lang="ts">
	// Reference-anchored "stringy" graph layout (ported from mini-web-viz-for-gfa).
	// Each segment is drawn as a strand whose length ∝ its sequence length; the
	// reference/backbone path is pinned to a straight horizontal line and variant
	// bubbles relax locally around it. The force layout runs in a Web Worker so a
	// dense subgraph never freezes the tab. Graph simplification happens upstream,
	// so this component just lays out and draws whatever graph it's given.
	import { onDestroy, untrack } from 'svelte';
	import { gfaStats, type Gfa } from '../gfa';
	import { gfaToGraph } from './gfaToGraph';
	import type { GfaGraph } from './types';
	import type { LayoutResult, SimNode, SegmentChain } from './forceLayout';
	import type { LayoutRequest, LayoutResponse } from './layout.worker';
	import GraphCanvas from './GraphCanvas.svelte';
	import QueryReport from './QueryReport.svelte';
	import { trackEvent } from '../analytics';
	import { transcriptsInRange, representativeTranscripts, type Transcript } from '../geneTrack';
	import type { RefKey } from '../genes';

	let {
		gfa,
		referenceSample,
		refKey,
		discoAvailable = false,
		discoLoading = false,
		onRequestDiscoGraph,
		discoWalksGfa = null,
		showingAllNodes = false,
		allNodesCount = 0,
		allNodesTooMany = false,
		onToggleSimplify,
		onRequestMoreContext,
		locusLabel = '',
		fetchInfo = null,
		querying = false
	}: {
		gfa: Gfa;
		referenceSample: string;
		refKey?: RefKey;
		/** Label for the query report at the top of the options panel: the gene
		 * symbol the user searched, or the coordinate string. */
		locusLabel?: string;
		/** Fetch stats from the query round-trip, shown in the report. */
		fetchInfo?: {
			requestCount: number;
			bytesFetched: number;
			dbSize: number;
			elapsedMs: number;
		} | null;
		/** A query round-trip is in flight (report shows the fetching phase). */
		querying?: boolean;
		/** Whether the parent can supply the full (unsimplified) graph — the one that
		 * still carries every haplotype walk — so disco-walks has anything to trace. */
		discoAvailable?: boolean;
		/** Parent is currently fetching that full graph. */
		discoLoading?: boolean;
		/** Ask the parent to load the full-walk graph (for disco-walks). */
		onRequestDiscoGraph?: () => void;
		/** The unsimplified graph, once loaded — the source of the walks disco traces.
		 * disco animates over the *displayed* graph, mapping these walks onto it, so
		 * this never has to be the graph on screen. */
		discoWalksGfa?: Gfa | null;
		/** Whether the full (unsimplified) graph is the one currently displayed. */
		showingAllNodes?: boolean;
		/** Node count the unsimplified graph would have (for the Simplify switch label). */
		allNodesCount?: number;
		/** The unsimplified graph is past the render ceiling — offer it as info, not a control. */
		allNodesTooMany?: boolean;
		/** Toggle between the simplified and full graph (parent owns the fetch/swap). */
		onToggleSimplify?: () => void;
		/** Raise the query context and re-run — offered when an off-locus exit is
		 * selected, to follow chopped haplotypes further past the locus. */
		onRequestMoreContext?: () => void;
	} = $props();

	// Keep all non-reference bubbles on one side (above the reference line). This
	// halves the vertical spread and, more importantly, leaves the space below the
	// backbone free for the gene track. On by default; the toggle restores the
	// symmetric two-sided layout.
	let bubblesAbove = $state(true);

	// Pull bubbles horizontally onto their reference node's x, so each stacks into a
	// tidy vertical column (on by default). Off gives the older, freer relaxation
	// where the link forces open bubbles out into more organic sideways shapes.
	let anchorToReference = $state(true);

	// Mark strands chopped at the subgraph boundary with a fading cue toward the
	// frame edge (the direction the haplotype leaves the locus), so they don't read
	// as random dangles. Off for a clean figure.
	let showExits = $state(true);

	// The two optional tracks drawn in bands under the backbone, inside the graph
	// canvas: variant arcs (just below the reference axis) above the gene track. Both
	// on by default; each can be switched off from the side panel. The arc threshold
	// hides variants below a given size (the reduce already pops most small ones).
	let showVariantArcs = $state(true);
	let showGeneTrack = $state(true);
	let arcMinLen = $state(50);

	// The two most-used controls (Simplify + disco) stay pinned; everything else
	// lives behind these sidebar tabs so the panel stays short as options grow.
	let ctlTab = $state<'layout' | 'nodes' | 'view'>('layout');

	// Render the graph on a light theme (for figures/publication) instead of the
	// dark screen one. The export button below writes a PNG of the current view.
	let lightMode = $state(false);
	let canvasApi = $state<{ exportImage: (filename: string) => void } | null>(null);

	// Which fields to surface about a node — in the hover tooltip and in the panel
	// under the graph when one is clicked (where the sequence gets room to be read
	// and copied). Sequence is off by default since it can be long.
	let showNodeId = $state(true);
	let showLength = $state(true);
	let showCoords = $state(true);
	let showSequence = $state(false);

	let selected = $state<string | null>(null);

	// A clicked gene/exon in the track below the graph, shown in the same floating
	// inspector as a node. The click callbacks below are mutually exclusive:
	// GraphCanvas emits them all on every click, so selecting one clears the rest.
	interface SelectedFeature {
		symbol: string;
		name: string;
		exonNum: number;
		nExons: number;
		contig: string;
		start: number;
		end: number;
	}
	let selectedFeature = $state<SelectedFeature | null>(null);

	// A clicked variant arc, shown in the inspector — the quantitative lens on the
	// track. `kind` says which side of the bubble was clicked (its net-insertion or
	// net-deletion arc); the rest describe the whole feature. Genomic coords are
	// absolute (already offset by the reference start).
	interface SelectedArc {
		kind: 'insertion' | 'deletion';
		reason: string;
		contig: string;
		gStart: number;
		gEnd: number;
		refSpan: number;
		longest: number;
		shortest: number;
		insertion: number;
		deletion: number;
	}
	let selectedArc = $state<SelectedArc | null>(null);
	// Whether the arc inspector's "how these are calculated" note is expanded.
	let arcInfoOpen = $state(false);

	// A clicked off-locus exit cue (a dashed strand leaving the subgraph), shown in
	// the same inspector.
	interface SelectedExit {
		segId: string;
		side: 'left' | 'right';
	}
	let selectedExit = $state<SelectedExit | null>(null);

	$effect(() => {
		gfa;
		selected = null;
		selectedFeature = null;
		selectedArc = null;
		selectedExit = null;
		// A new graph gets a fresh automatic rough/full decision (see effectiveRough).
		roughOverride = null;
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
	// Cycle a spotlight through every walk, one per tick, tracing each through the
	// graph that's on screen. Walks live only in the unsimplified graph (the reduced
	// one aggregates them into coverage tags), so we take them from `discoWalksGfa`
	// and map each walk's original node ids onto the displayed segment that stands
	// for them — the unchop-merged u-chain (via the `members` tag), or nothing for a
	// popped small variant (a gap in the trace). On the full graph that mapping is
	// the identity and the trace is exact; on the simplified graph it's a partial
	// but still recognisable path (missing whatever got collapsed away).
	const DISCO_INTERVAL_MS = 100;

	// Where the walks come from: the unsimplified graph if we've loaded it, else the
	// displayed graph when it already carries walks (i.e. it isn't the reduced one).
	const walksGfa = $derived(discoWalksGfa ?? (gfa.reduced ? null : gfa));

	interface DiscoWalk {
		steps: { id: string; orient: '+' | '-' }[];
	}
	const discoWalks = $derived.by((): DiscoWalk[] => {
		const src = walksGfa;
		if (!src) return [];
		const out: DiscoWalk[] = [];
		// Collapse walks that trace the same segments. At a repetitive/hypervariable
		// locus (e.g. HLA-A) gbz-base fragments haplotypes into many identical short
		// walk records; left in, the cycle spends seconds re-highlighting the same
		// handful of nodes, which reads as one node "blinking" forever. Direction
		// doesn't change the drawn line, so normalise a walk and its reverse to one
		// key and keep only the first walk with each distinct trace.
		const seen = new Set<string>();
		for (const w of src.walks) {
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

	// Map every original node id to the displayed segment that represents it — the
	// segment itself, or the unchop-merged u-chain that swallowed it (`members`).
	// Popped small variants aren't in the map. On the full graph this is 1:1.
	const origToDisplayed = $derived.by(() => {
		const m = new Map<string, string>();
		for (const seg of gfa.segments.values()) {
			m.set(seg.id, seg.id);
			if (seg.members) for (const orig of seg.members) m.set(orig, seg.id);
		}
		return m;
	});

	const canDiscoNow = $derived(discoWalks.length > 0);

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
		// Need the walks; ask the parent to load the unsimplified graph. Only its
		// walks are used — the displayed graph stays exactly as it is.
		pendingDisco = true;
		trackEvent('widget_interact', { widget: 'graph_layout', action: 'disco_walks_start' });
		onRequestDiscoGraph?.();
	}

	// Start a pending run as soon as the walks arrive. There's no layout to wait for
	// — disco animates over whatever graph is already on screen.
	$effect(() => {
		if (pendingDisco && canDiscoNow) {
			pendingDisco = false;
			discoIndex = 0;
			disco = true;
		}
	});

	// The load finished (or failed) without producing walks — give up on the pending
	// start rather than showing "loading" forever.
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
	// Project the current walk onto the displayed segments: map each step through
	// origToDisplayed, drop steps with no representative here (popped), and collapse
	// a run of steps that all landed in the same displayed segment into one.
	const discoPath = $derived.by(() => {
		const w = currentDiscoWalk;
		if (!w) return null;
		const out: { id: string; orient: '+' | '-' }[] = [];
		let lastId: string | null = null;
		for (const step of w.steps) {
			const id = origToDisplayed.get(step.id);
			if (!id || id === lastId) continue;
			out.push({ id, orient: step.orient });
			lastId = id;
		}
		return out.length > 0 ? out : null;
	});
	// Spin the hue with the cycle so each walk gets its own disco color; darker on
	// the light theme so it reads against white.
	const discoColor = $derived(`hsl(${(discoIndex * 47) % 360}, 95%, ${lightMode ? 45 : 62}%)`);
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

	// Gene models for the track under the backbone, fetched from UCSC bigBed. Best-
	// effort: on any failure (or when the track is switched off) it stays empty and
	// the graph is unaffected.
	let genes = $state<Transcript[]>([]);
	$effect(() => {
		const win = locusWindow;
		const key = refKey;
		if (!win || !key || !showGeneTrack) {
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

	// Variant arcs: one per non-reference feature the reducer could not collapse
	// (the reduced Gfa's `Y` / KeptSite records — see gfa.ts). Each marks a bubble
	// that stayed in the graph, spanning the reference coordinates it covers. A
	// bubble contributes a net-insertion arc when its longest walk runs longer than
	// the reference it spans, and/or a net-deletion arc when its shortest walk runs
	// shorter — carrying the reason it resisted collapse. No layout needed; placed
	// in absolute genomic coordinates via the reference walk's start so the canvas
	// positions them through the same reference anchors as the gene track.
	interface SiteArc {
		reason: string;
		contig: string;
		/** Genomic bp of the bubble's left/right reference edges. */
		gStart: number;
		gEnd: number;
		/** Reference bp the bubble spans (gEnd - gStart). */
		refSpan: number;
		/** Longest / shortest walk through the bubble, in alt bp. */
		longest: number;
		shortest: number;
		/** Net insertion (longest beyond the span) and net deletion (span beyond
		 * shortest); either can be 0. */
		insertion: number;
		deletion: number;
	}
	const siteArcs = $derived.by((): SiteArc[] => {
		if (!showVariantArcs || gfa.sites.length === 0) return [];
		const ref = gfa.walks.find((w) => w.sample === referenceSample) ?? gfa.walks[0];
		const base = ref?.start ?? 0;
		const contig = ref?.seqId ?? '';
		return gfa.sites
			.map((s): SiteArc => {
				const refSpan = Math.max(0, s.end - s.start);
				return {
					reason: s.reason,
					contig,
					gStart: base + s.start,
					gEnd: base + s.end,
					refSpan,
					longest: s.longest,
					shortest: s.shortest,
					insertion: Math.max(0, s.longest - refSpan),
					deletion: Math.max(0, refSpan - s.shortest)
				};
			})
			// Hide features whose net change is below the size threshold.
			.filter((s) => Math.max(s.insertion, s.deletion) >= arcMinLen);
	});

	// Past this node count the full-quality layout takes minutes, so switch to a
	// rough one automatically rather than making people wait. Below it, quality is
	// cheap. This is the automatic default; the "Rough layout" switch lets the user
	// override it either way for the current graph.
	const LARGE_LAYOUT_NODE_THRESHOLD = 2000;
	const autoRough = $derived(adapted.keptSegments > LARGE_LAYOUT_NODE_THRESHOLD);
	// null = follow the automatic default; true/false = a manual override. Reset to
	// null on every new graph so rough mode keeps adapting automatically per query.
	let roughOverride = $state<boolean | null>(null);
	const effectiveRough = $derived(roughOverride ?? autoRough);

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
	// `mainReqId` is the id of the layout request we're currently awaiting; a
	// response with any other id has been superseded and is dropped.
	let nextReqId = 0;
	let mainReqId = -1;
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
	// The gfa the current `layout` was built for, so we can tell a re-layout of the
	// same graph (a knob toggle) from a switch to a different graph.
	let layoutGfa = $state.raw<Gfa | null>(null);
	let mainReqGfa: Gfa | null = null;
	// True while a recompute is running that we can keep the current canvas up for
	// (same graph, just new knobs) — so a toggle updates in place instead of blanking
	// the view behind the "computing" overlay.
	let recomputeKeepsCanvas = $state(false);

	// A provisional, backbone-only layout built straight from the reference
	// coordinates — no force simulation, so it's ready the instant the query returns.
	// It lays the reference segments out along a horizontal line by cumulative bp,
	// which is all GraphCanvas needs to draw the reference axis and place the variant
	// and gene tracks. We show it while the real (bubble-relaxing) layout is still
	// computing, so on a big, slow locus the quantitative tracks appear right away and
	// the graph strands fill in when they're ready. The provisional backbone carries
	// no bubbles or coverage, so the graph area reads as "still forming".
	const provisionalLayout = $derived.by((): LayoutResult | null => {
		if (refCoords.size === 0) return null;
		// Reference segments in genomic order — monotone along the backbone, the same
		// assumption the coordinate axis relies on.
		const segs = [...refCoords.entries()].sort((a, b) => a[1].start - b[1].start);
		const nodesById = new Map<string, SimNode>();
		const chains: SegmentChain[] = [];
		const backboneSegIds = new Set<string>();
		const segmentLengths = new Map<string, number>();
		let x = 0;
		for (const [segId, c] of segs) {
			const len = Math.max(1, c.end - c.start);
			const startId = `${segId}#s`;
			const endId = `${segId}#e`;
			// Two nodes per segment (start + end) so the chain has real on-screen width
			// for the bp→x mapping; y is a flat baseline the fit will center.
			const mk = (id: string, posIndex: number, nx: number): SimNode => ({
				id,
				segId,
				posIndex,
				isChainEnd: true,
				x: nx,
				y: 0,
				componentBaselineY: 0
			});
			nodesById.set(startId, mk(startId, 0, x));
			nodesById.set(endId, mk(endId, 1, x + len));
			chains.push({ segId, nodeIds: [startId, endId] });
			backboneSegIds.add(segId);
			segmentLengths.set(segId, len);
			x += len;
		}
		return {
			nodesById,
			chains,
			structuralLinkPaths: [],
			backbones: [],
			backboneSegIds,
			segmentLengths,
			pathCoverage: new Map(),
			maxPathCoverage: 0
		};
	});

	// The real layout only stands in for the current graph once it's been built *for*
	// it — during a fresh query the previous graph's layout is still in `layout`, so
	// we fall back to the provisional backbone for the new locus rather than showing
	// the stale graph. `usingProvisional` drives the lighter "still computing" badge
	// (instead of the full blanking overlay) so the preview stays visible.
	const layoutIsCurrent = $derived(layout != null && layoutGfa === gfa);
	const displayLayout = $derived(layoutIsCurrent ? layout : (provisionalLayout ?? layout));
	const usingProvisional = $derived(displayLayout != null && displayLayout === provisionalLayout);

	// The layout-shaping options the user controls — anything here changes the
	// computed layout, so it's the worker's options.
	interface LayoutKnobs {
		bubblesAbove: boolean;
		anchorToReference: boolean;
		// The rough override only (null = auto); the effective rough decision folds in
		// each graph's own node count inside layoutOptionsFor.
		roughOverride: boolean | null;
	}
	const layoutKnobs = $derived<LayoutKnobs>({ bubblesAbove, anchorToReference, roughOverride });

	// Worker options for a graph of this size. Rough mode (past the threshold unless
	// overridden) collapses each segment to one node, cuts iterations and drops bend
	// nodes — the much faster layout (see the 62.5s→6.0s note); otherwise full quality.
	function layoutOptionsFor(keptSegments: number, knobs: LayoutKnobs): LayoutRequest['options'] {
		const { bubblesAbove, anchorToReference, roughOverride } = knobs;
		const rough = roughOverride ?? keptSegments > LARGE_LAYOUT_NODE_THRESHOLD;
		const base = { referenceSample, bubblesAbove, anchorToReference };
		return rough
			? { ...base, maxEdgesPerSegment: 1, targetTotalSubNodes: 400, iterations: 60, bendNodes: false }
			: base;
	}

	function ensureWorker(): Worker {
		if (!worker) {
			worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
			worker.onmessage = (ev: MessageEvent<LayoutResponse>) => {
				if (ev.data.id !== mainReqId) return; // superseded — drop it
				layout = ev.data.layout;
				ms = ev.data.ms;
				layoutGfa = mainReqGfa;
				computing = false;
				recomputeKeepsCanvas = false;
			};
		}
		return worker;
	}

	// `graph` traces back into `gfa`, which the parent now holds as `$state.raw` —
	// so its nodes/links/steps are plain objects, not Svelte Proxies, and
	// `postMessage` can structured-clone the graph directly. (Under plain `$state`
	// this needed a `$state.snapshot` to de-proxy first, and that de-proxy was the
	// ~1s main-thread stall when re-laying-out the full graph.)
	function postLayout(graph: GfaGraph, options: LayoutRequest['options']): number {
		const id = ++nextReqId;
		ensureWorker().postMessage({ id, graph, options } satisfies LayoutRequest);
		return id;
	}

	// Kick off a (re)layout whenever the displayed graph or a layout knob changes.
	$effect(() => {
		const graph = adapted.graph;
		const knobs = layoutKnobs;
		// Same graph, only the knobs changed → keep the current canvas up while it
		// re-lays out, so a toggle updates in place instead of blanking the view.
		recomputeKeepsCanvas = untrack(() => layout != null && layoutGfa === gfa);
		computing = true;
		mainReqGfa = gfa;
		mainReqId = postLayout(graph, layoutOptionsFor(adapted.keptSegments, knobs));
	});

	onDestroy(() => worker?.terminate());

	// Feed the query report at the top of the options panel. `reportComputing`
	// excludes quick in-place recomputes (knob toggles) — those get the canvas
	// busy-badge, not a full report takeover. `reportBusy` also dims the controls.
	const reportStats = $derived(gfaStats(gfa, referenceSample));
	const reportComputing = $derived(computing && !recomputeKeepsCanvas);
	const reportBusy = $derived(querying || reportComputing);

	// Human-readable form of a kept-site reason code (see gfa.ts KeptSite.reason).
	function reasonLabel(reason: string): string {
		switch (reason) {
			case 'large-variant':
				return 'too large to collapse';
			case 'cyclic':
				return 'cyclic — inversion or tandem repeat';
			case 'tangled':
				return 'tangled — not a clean bubble';
			case 'unwitnessed':
				return 'contains an edge no walk takes';
			case 'complex':
				return 'complex — not a clean bubble';
			default:
				return reason;
		}
	}

	const selectedLen = $derived(selected ? (gfa.segments.get(selected)?.length ?? null) : null);
	const selectedCoord = $derived(selected ? (refCoords.get(selected) ?? null) : null);
	function fmtCoord(c: RefCoord): string {
		return `${c.contig}:${c.start.toLocaleString()}–${c.end.toLocaleString()}`;
	}

	function exportImage() {
		const win = locusWindow;
		const base = win ? `${win.contig}_${win.start}-${win.end}` : 'graphoscope-graph';
		canvasApi?.exportImage(`${base}.png`);
	}

	// Tooltip text for a hovered node, built from the fields the user has enabled.
	// Sequence is truncated here (the full one lives in the panel under the graph).
	function nodeTooltip(segId: string): string {
		const seg = gfa.segments.get(segId);
		const parts: string[] = [];
		if (showNodeId) parts.push(segId);
		if (showLength) parts.push(`${(seg?.length ?? 0).toLocaleString()} bp`);
		if (showCoords) {
			const c = refCoords.get(segId);
			if (c) parts.push(fmtCoord(c));
		}
		if (showSequence && seg?.seq) {
			parts.push(seg.seq.length > 40 ? `${seg.seq.slice(0, 40)}…` : seg.seq);
		}
		return parts.join(' · ') || segId;
	}

	const selectedSeq = $derived(selected ? (gfa.segments.get(selected)?.seq ?? '') : '');
	async function copySelectedSeq() {
		if (selectedSeq) await navigator.clipboard.writeText(selectedSeq);
	}
</script>

<div class="wrap">
	<div class="body">
		<aside class="sidebar">
			<!-- Query report: progressive while a query/layout runs, then a one-liner. -->
			<QueryReport
				{locusLabel}
				stats={reportStats}
				reduced={gfa.reduced ?? null}
				{fetchInfo}
				{querying}
				computing={reportComputing}
				layoutMs={ms}
			/>

			<div class="ctl-wrap" class:dimmed={reportBusy}>
			<!-- Pinned primary controls: the two most-reached-for switches. -->
			<section class="group primary">
				{#if discoAvailable || showingAllNodes}
					<label
						class="switch"
						title="Collapse small variants and merge unbranched runs (default), or show every node in the full graph"
					>
						<input
							type="checkbox"
							checked={!showingAllNodes}
							disabled={discoLoading}
							onchange={() => onToggleSimplify?.()}
						/>
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">Simplify</span>
							<span class="switch-sub">
								{#if discoLoading}
									loading…
								{:else if showingAllNodes}
									all {allNodesCount.toLocaleString()} nodes shown
								{:else}
									small variants collapsed
								{/if}
							</span>
						</span>
					</label>
				{:else if allNodesTooMany}
					<span class="switch-sub note">{allNodesCount.toLocaleString()} nodes — too many to render in full</span>
				{/if}
				{#if showDiscoButton}
					<button
						class="disco"
						class:on={disco}
						onclick={toggleDisco}
						disabled={discoLoading || pendingDisco}
						title="Spotlight every walk in turn, tracing each one through the graph (uses the full unsimplified graph)"
					>
						{#if discoLoading || pendingDisco}
							🪩 loading walks…
						{:else if disco}
							🪩 stop · walk {(discoIndex % discoWalks.length) + 1}/{discoWalks.length}
						{:else}
							🪩 disco-walks
						{/if}
					</button>
					{#if disco}
						<span class="switch-sub">spotlighting each of {discoWalks.length.toLocaleString()} unique walks</span>
					{/if}
				{/if}
			</section>

			<!-- Tracks drawn in bands under the backbone (inside the canvas). Pinned
			     (not tabbed) since they toggle what's shown rather than shaping the
			     layout: variant arcs just below the reference axis, genes below them. -->
			<section class="group tracks-group">
				<span class="group-title">Tracks under graph</span>
				<label class="switch" title="Draw the variant arcs on the reference axis: non-reference nodes as arcs (reach ∝ event size), insertions arcing up and deletions down. Click one for its coverage and net length.">
					<input type="checkbox" bind:checked={showVariantArcs} />
					<span class="track"><span class="thumb"></span></span>
					<span class="switch-text">
						<span class="switch-label">Variant arcs</span>
						<span class="switch-sub">insertions up, deletions down</span>
					</span>
				</label>
				{#if showVariantArcs}
					<label class="thresh" title="Hide variants smaller than this. The reduce already pops most small ones; the survivors failed a safety check.">
						hide variants under
						<input type="number" min="1" max="1000" step="1" bind:value={arcMinLen} /> bp
					</label>
				{/if}
				<label class="switch" title="Draw the gene track (exons, strand, UTRs) below the variant arcs, on the same reference axis.">
					<input type="checkbox" bind:checked={showGeneTrack} />
					<span class="track"><span class="thumb"></span></span>
					<span class="switch-text">
						<span class="switch-label">Genes</span>
						<span class="switch-sub">annotated transcripts</span>
					</span>
				</label>
			</section>

			<!-- Secondary controls, grouped into tabs so the panel doesn't grow forever. -->
			<nav class="ctl-tabs">
				<button class:active={ctlTab === 'layout'} onclick={() => (ctlTab = 'layout')}>Layout</button>
				<button class:active={ctlTab === 'nodes'} onclick={() => (ctlTab = 'nodes')}>Nodes</button>
				<button class:active={ctlTab === 'view'} onclick={() => (ctlTab = 'view')}>View</button>
			</nav>
			<section class="group ctl-panel">
				{#if ctlTab === 'layout'}
					<label class="switch" title="Keep variant bubbles on one side, freeing the space below the reference line for the gene track">
						<input type="checkbox" bind:checked={bubblesAbove} />
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">One-sided</span>
							<span class="switch-sub">bubbles above the line</span>
						</span>
					</label>
					<label class="switch" title="Pull each bubble onto its reference node's position so it stacks straight up. Off lets bubbles relax into freer, more organic shapes.">
						<input type="checkbox" bind:checked={anchorToReference} />
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">Anchor to reference</span>
							<span class="switch-sub">stack bubbles over their ref nodes</span>
						</span>
					</label>
					<label
						class="switch"
						title="Draw smooth, curved strands (full quality). Off is a faster, straighter layout, chosen automatically for very large graphs; toggle to override it for this graph."
					>
						<input
							type="checkbox"
							checked={!effectiveRough}
							onchange={() => (roughOverride = !effectiveRough)}
						/>
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">Bendy nodes</span>
							<span class="switch-sub">
								{effectiveRough ? 'straight, faster' : 'smooth, full quality'}{roughOverride === null
									? ' · auto'
									: ''}
							</span>
						</span>
					</label>
					<label
						class="switch"
						title="Mark strands cut off at the locus edge with a fading dashed cue toward the side they leave on (their continuation is outside this subgraph). Off for a clean figure."
					>
						<input type="checkbox" bind:checked={showExits} />
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">Off-locus exits</span>
							<span class="switch-sub">cue chopped-off haplotypes</span>
						</span>
					</label>
				{:else if ctlTab === 'nodes'}
					<span class="group-hint">shown on hover, and under the graph when clicked</span>
					<label class="check"><input type="checkbox" bind:checked={showNodeId} /> Node ID</label>
					<label class="check"><input type="checkbox" bind:checked={showLength} /> Length (bp)</label>
					<label class="check"><input type="checkbox" bind:checked={showCoords} /> Coordinates</label>
					<label class="check"><input type="checkbox" bind:checked={showSequence} /> Sequence</label>
				{:else if ctlTab === 'view'}
					<label class="switch" title="Render on a white background for figures and publication screenshots">
						<input type="checkbox" bind:checked={lightMode} />
						<span class="track"><span class="thumb"></span></span>
						<span class="switch-text">
							<span class="switch-label">Light mode</span>
							<span class="switch-sub">white background for figures</span>
						</span>
					</label>
					<button class="action" onclick={exportImage} title="Download the current view as a high-resolution PNG">
						⬇ Export PNG
					</button>
				{/if}
			</section>
			</div>
		</aside>

	<div class="stage-col">
			<div class="stage">
				{#if displayLayout}
					<GraphCanvas
						layout={displayLayout}
						{refCoords}
						{genes}
						sites={siteArcs}
						showArcs={showVariantArcs}
						showGenes={showGeneTrack}
						{discoPath}
						{discoColor}
						{lightMode}
						{nodeTooltip}
						{showExits}
						discoActive={disco}
						onReady={(api) => (canvasApi = api)}
						onSelectSegment={(id) => {
							selected = id;
							if (id) trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_node' });
						}}
						onSelectFeature={(f) => {
							selectedFeature = f;
							if (f) trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_gene' });
						}}
						onSelectArc={(a) => {
							selectedArc = a;
							arcInfoOpen = false;
							if (a) trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_arc' });
						}}
						onSelectExit={(e) => {
							selectedExit = e;
							if (e) trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_exit' });
						}}
					/>
				{/if}
				{#if computing && !recomputeKeepsCanvas && !usingProvisional}
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
					<!-- Provisional preview up (the reference axis + tracks are already drawn) or
					     an in-place recompute: keep the canvas visible and just badge it, rather
					     than blanking it behind the overlay above. -->
				{:else if computing && usingProvisional}
					<div class="busy-badge">
						<span class="spinner"></span> laying out the graph…
					</div>
					{#if showSlowLayoutWarning}
						<div class="preview-note">
							{adapted.keptSegments.toLocaleString()} nodes — the graph can take a few minutes on a large or
							repetitive locus. The variant&nbsp;arcs and gene track below are ready now.
						</div>
					{/if}
				{:else if computing}
					<div class="busy-badge">
						<span class="spinner"></span> computing layout…
					</div>
				{/if}

				<!-- Floating node inspector: only present while a node is selected, so it
				     never reserves layout space (click empty graph or × to dismiss). -->
				{#if selected}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">
								{#if showNodeId}Node <code>{selected}</code>{:else}Node{/if}
							</span>
							<button class="insp-close" onclick={() => (selected = null)} aria-label="Close">×</button>
						</div>

						{#if showLength || showCoords}
							<div class="ni-fields">
								{#if showLength}
									<span class="ni-field"
										><span class="ni-key">length</span> {selectedLen?.toLocaleString() ?? '—'} bp</span
									>
								{/if}
								{#if showCoords}
									<span class="ni-field"
										><span class="ni-key">coords</span>
										{#if selectedCoord}<span class="coord">{fmtCoord(selectedCoord)}</span>{:else}<span
												class="muted">—</span
											>{/if}</span
									>
								{/if}
							</div>
						{/if}

						{#if showSequence}
							<div class="ni-seq">
								<div class="ni-seq-head">
									<span class="ni-key">sequence</span>
									{#if selectedSeq}
										<span class="muted">{selectedSeq.length.toLocaleString()} bp</span>
										<button class="copy" onclick={copySelectedSeq}>copy</button>
									{/if}
								</div>
								{#if selectedSeq}
									<textarea class="seq-box" readonly rows="3" onclick={(e) => e.currentTarget.select()}
										>{selectedSeq}</textarea
									>
								{:else}
									<span class="muted">no sequence stored for this node</span>
								{/if}
							</div>
						{/if}

						{#if endpointCounts}
							{@const total = endpointCounts.starts + endpointCounts.ends}
							<div class="endpoints">
								<span class="hint muted">
									a walk dead-ending here usually indicates a haplotype connects to another locus and
									got chopped off this subgraph
								</span>
								<span class="etag"
									>{total.toLocaleString()} walk{total === 1 ? ' starts/ends' : 's start/end'} here</span
								>
							</div>
						{:else if endpoints.length > 0}
							<div class="endpoints">
								<span class="hint muted">
									a walk dead-ending here usually indicates a haplotype connects to another locus and
									got chopped off this subgraph
								</span>
								<div class="erow">
									<span class="etag"
										>{endpoints.length} walk{endpoints.length === 1
											? ' starts/ends'
											: 's start/end'} here</span
									>
									{#each endpoints.slice(0, 6) as e (e.label)}
										<span class="chip">{e.label} · {e.length.toLocaleString()}bp</span>
									{/each}
									{#if endpoints.length > 6}<span class="muted">+{endpoints.length - 6}</span>{/if}
								</div>
							</div>
						{/if}
					</div>
				{:else if selectedFeature}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">Gene <code>{selectedFeature.symbol}</code></span>
							<button class="insp-close" onclick={() => (selectedFeature = null)} aria-label="Close"
								>×</button
							>
						</div>
						<div class="ni-fields">
							{#if selectedFeature.name && selectedFeature.name !== selectedFeature.symbol}
								<span class="ni-field"><span class="ni-key">name</span> {selectedFeature.name}</span>
							{/if}
							<span class="ni-field"
								><span class="ni-key">exon</span> {selectedFeature.exonNum} of
								{selectedFeature.nExons}</span
							>
							<span class="ni-field"
								><span class="ni-key">coords</span>
								<span class="coord"
									>{selectedFeature.contig}:{selectedFeature.start.toLocaleString()}–{selectedFeature.end.toLocaleString()}</span
								></span
							>
							<span class="ni-field"
								><span class="ni-key">length</span>
								{(selectedFeature.end - selectedFeature.start).toLocaleString()} bp</span
							>
						</div>
					</div>
				{:else if selectedArc}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title"
								>{selectedArc.kind === 'insertion' ? 'Insertion' : 'Deletion'}</span
							>
							<div class="insp-actions">
								<button
									class="insp-info"
									class:on={arcInfoOpen}
									onclick={() => (arcInfoOpen = !arcInfoOpen)}
									aria-label="How these values are calculated"
									aria-expanded={arcInfoOpen}
									title="How these values are calculated">ⓘ</button
								>
								<button class="insp-close" onclick={() => (selectedArc = null)} aria-label="Close"
									>×</button
								>
							</div>
						</div>
						{#if arcInfoOpen}
							<p class="insp-explain">
								Each arc is a whole bubble the reducer <b>could not collapse</b> — an alternate region
								off the reference, not a single node — spanning the reference it covers. The
								<b>longest walk</b> is the deepest path any haplotype takes through it (and sets the
								insertion height); the <b>shortest walk</b> is the shallowest. A walk longer than the
								span is a <b>net insertion</b>, one shorter a <b>net deletion</b>. <b>reason</b> is why
								it stayed in the graph.
							</p>
						{/if}
						<div class="ni-fields">
							{#if selectedArc.kind === 'insertion'}
								<span class="ni-field"
									><span class="ni-key">net insertion</span> +{selectedArc.insertion.toLocaleString()}
									bp</span
								>
								<span class="ni-field"
									><span class="ni-key">longest walk</span> {selectedArc.longest.toLocaleString()} bp</span
								>
							{:else}
								<span class="ni-field"
									><span class="ni-key">net deletion</span> −{selectedArc.deletion.toLocaleString()}
									bp</span
								>
								<span class="ni-field"
									><span class="ni-key">shortest walk</span> {selectedArc.shortest.toLocaleString()} bp</span
								>
							{/if}
							<span class="ni-field"
								><span class="ni-key">spans</span> {selectedArc.refSpan.toLocaleString()} bp of reference</span
							>
							<span class="ni-field"
								><span class="ni-key">reason</span> {reasonLabel(selectedArc.reason)}</span
							>
							<span class="ni-field"
								><span class="ni-key">coords</span>
								<span class="coord"
									>{selectedArc.contig}:{selectedArc.gStart.toLocaleString()}{selectedArc.gStart !==
									selectedArc.gEnd
										? '–' + selectedArc.gEnd.toLocaleString()
										: ''}</span
								></span
							>
						</div>
					</div>
				{:else if selectedExit}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">Off-locus exit</span>
							<button class="insp-close" onclick={() => (selectedExit = null)} aria-label="Close"
								>×</button
							>
						</div>
						<p class="exit-note">
							A haplotype leaves the queried window here and continues into the graph
							<b>beyond the region that was fetched</b>. We can't show where it reconnects — that node
							is outside this subgraph — so it's drawn as a dashed cue toward the
							{selectedExit.side} edge, the direction it exits.
						</p>
						{#if onRequestMoreContext}
							<button class="exit-more" onclick={() => onRequestMoreContext?.()}>
								Increase context &amp; re-query
							</button>
							<span class="exit-hint">
								Widens the window past the locus so the query follows these haplotypes further — fewer
								dangling exits, more nodes shown.
							</span>
						{/if}
					</div>
				{/if}
			</div>
		<div class="foot">
			<span class="muted">plain scroll pans · ⌘/ctrl-scroll (or pinch) zooms</span>
			<span class="spacer"></span>
			{#if showVariantArcs && siteArcs.length > 0}
				<span class="legend arc-legend" title="Each arc is a bubble that could not be collapsed: insertions arc up, deletions down">
					<span class="al"><span class="asw" style="background:#1d4ed8"></span>net insertion</span>
					<span class="al"><span class="asw" style="background:#dc2626"></span>net deletion</span>
				</span>
			{/if}
			<span class="legend"><span class="sw backbone"></span> reference backbone</span>
			<span class="legend"><span class="sw grad"></span> more walks through node →</span>
		</div>
	</div>
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
		height: 100%;
		padding: 0.6rem;
	}
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

	/* Body: a controls sidebar beside the canvas. Grows to fill the wrap so the
	   canvas gets the whole available height. */
	.body {
		display: flex;
		gap: 0.75rem;
		align-items: stretch;
		flex: 1;
		min-height: 0;
	}
	/* The graph column: canvas above its own footer, so the scroll/zoom hint and
	   legend sit under the graph rather than spanning under the sidebar too. */
	.stage-col {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.sidebar {
		flex: 0 0 224px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		font-size: 0.8rem;
		overflow-y: auto;
		padding-right: 0.15rem;
	}
	.ctl-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		transition: opacity 0.15s ease;
	}
	.ctl-wrap.dimmed {
		opacity: 0.4;
		pointer-events: none;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0.5rem 0.6rem;
		background: #fafafa;
		border: 1px solid #eee;
		border-radius: 8px;
	}
	.group-hint {
		font-size: 0.7rem;
		color: #9aa0aa;
		margin-top: -0.2rem;
	}
	.group-title {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #9aa0aa;
	}
	.tracks-group {
		background: #fff;
	}
	/* Threshold input under the Variant arcs switch. */
	.thresh {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.72rem;
		color: #6b7280;
		margin-left: 0.15rem;
	}
	.thresh input {
		width: 3.6rem;
		font: inherit;
		font-size: 0.75rem;
		padding: 0.12rem 0.3rem;
		border: 1px solid #d3d6dd;
		border-radius: 5px;
	}

	/* Pinned primary controls sit a touch brighter than the tabbed panel below. */
	.primary {
		background: #fff;
		gap: 0.5rem;
	}

	/* Sidebar control tabs (Layout / Nodes / View). */
	.ctl-tabs {
		display: flex;
		gap: 2px;
		background: #eef0f4;
		border: 1px solid #e6e8ec;
		border-radius: 8px;
		padding: 2px;
	}
	.ctl-tabs button {
		flex: 1;
		font: inherit;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		background: transparent;
		border: none;
		color: #6b7280;
		padding: 0.3rem 0.2rem;
		border-radius: 6px;
	}
	.ctl-tabs button:hover {
		color: #333;
	}
	.ctl-tabs button.active {
		background: #fff;
		color: #2563eb;
		box-shadow: 0 1px 2px rgba(16, 24, 40, 0.1);
	}
	.ctl-panel {
		gap: 0.6rem;
	}

	/* Compact checkbox rows (node-info field picker). */
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: #333;
		cursor: pointer;
	}
	.check input {
		width: 15px;
		height: 15px;
		accent-color: #2563eb;
		cursor: pointer;
	}

	/* Toggle switch. */
	.switch {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		cursor: pointer;
	}
	.switch input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.track {
		flex: 0 0 auto;
		position: relative;
		width: 32px;
		height: 18px;
		margin-top: 1px;
		border-radius: 999px;
		background: #d3d6dd;
		transition: background 0.15s ease;
	}
	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
		transition: transform 0.15s ease;
	}
	.switch input:checked + .track {
		background: #2563eb;
	}
	.switch input:checked + .track .thumb {
		transform: translateX(14px);
	}
	.switch input:focus-visible + .track {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}
	.switch-text {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
	}
	.switch-label {
		color: #333;
	}
	.switch-sub {
		color: #9aa0aa;
		font-size: 0.7rem;
	}
	.switch-sub.note {
		color: #b45309;
	}

	.disco {
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		border: 1px solid #d1c4f0;
		background: #f6f2ff;
		color: #5b21b6;
		padding: 0.32rem 0.5rem;
		border-radius: 8px;
		white-space: nowrap;
		text-align: center;
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
	.action {
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
		border: 1px solid #d3d6dd;
		background: #fff;
		color: #333;
		padding: 0.3rem 0.5rem;
		border-radius: 8px;
		text-align: center;
	}
	.action:hover {
		border-color: #9aa0aa;
		background: #f6f7f9;
	}
	.stage {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 300px;
		position: relative;
		border: 1px solid #eee;
		border-radius: 8px;
		overflow: hidden;
		background: #0b0d12;
	}

	/* Stack the sidebar above the canvas on narrow screens. */
	@media (max-width: 640px) {
		.body {
			flex-direction: column;
		}
		.sidebar {
			flex-basis: auto;
		}
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
	/* Non-blocking "still working" pill for in-place recomputes: sits in a corner
	   over the (still-visible, still-interactive) graph. */
	.busy-badge {
		position: absolute;
		top: 10px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.4rem;
		pointer-events: none;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		background: rgba(11, 13, 18, 0.78);
		border: 1px solid rgba(154, 163, 178, 0.3);
		color: #cbd3e0;
		font-size: 0.76rem;
	}
	/* Note under the badge while the provisional preview is up on a slow locus,
	   explaining that the tracks are ready and the graph is still forming. */
	.preview-note {
		position: absolute;
		top: 42px;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(90%, 30rem);
		pointer-events: none;
		text-align: center;
		padding: 0.3rem 0.7rem;
		border-radius: 8px;
		background: rgba(11, 13, 18, 0.7);
		border: 1px solid rgba(154, 163, 178, 0.25);
		color: #cbd3e0;
		font-size: 0.74rem;
		line-height: 1.45;
	}
	.spinner {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid rgba(154, 163, 178, 0.35);
		border-top-color: #a9c7ff;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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
	.arc-legend {
		gap: 0.55rem;
		flex-wrap: wrap;
	}
	.arc-legend .al {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: #6b7280;
	}
	.asw {
		display: inline-block;
		width: 14px;
		height: 3px;
		border-radius: 2px;
	}
	.muted {
		color: #888;
	}
	.coord {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: #2563eb;
		white-space: nowrap;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	/* Floating node inspector, overlaid on the graph while a node is selected. */
	.inspector {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 5;
		width: 272px;
		max-width: calc(100% - 20px);
		max-height: calc(100% - 20px);
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		font-size: 0.82rem;
		background: #fff;
		border: 1px solid #d7dbe2;
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		box-shadow: 0 10px 28px rgba(16, 24, 40, 0.22);
	}
	.insp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.insp-title {
		font-weight: 600;
		color: #1f2430;
	}
	.insp-title code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
	}
	.insp-actions {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.1rem;
	}
	.insp-info {
		background: none;
		border: none;
		font-size: 0.95rem;
		line-height: 1;
		color: #98a0ac;
		cursor: pointer;
		padding: 0 0.15rem;
	}
	.insp-info:hover,
	.insp-info.on {
		color: #2563eb;
	}
	.insp-explain {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.45;
		color: #4b5563;
		background: #f6f8fc;
		border: 1px solid #e3e7ee;
		border-radius: 6px;
		padding: 0.4rem 0.55rem;
	}
	.insp-explain b {
		color: #1f2430;
	}
	.insp-close {
		flex: 0 0 auto;
		background: none;
		border: none;
		font-size: 1.2rem;
		line-height: 1;
		color: #98a0ac;
		cursor: pointer;
		padding: 0 0.15rem;
	}
	.insp-close:hover {
		color: #1f2430;
	}
	.ni-fields {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.ni-key {
		color: #9aa0aa;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-right: 0.15rem;
	}
	.ni-seq {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.ni-seq-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.copy {
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
		border: 1px solid #d3d6dd;
		background: #fff;
		color: #333;
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
	}
	.copy:hover {
		border-color: #9aa0aa;
		background: #f6f7f9;
	}
	.seq-box {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.74rem;
		line-height: 1.5;
		color: #1f2937;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 0.35rem 0.45rem;
		white-space: pre-wrap;
		word-break: break-all;
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
		background: #fef3c7;
		color: #92400e;
		align-self: flex-start;
	}
	.chip {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 0.05rem 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.74rem;
	}
	.exit-note {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.45;
		color: #4b5563;
	}
	.exit-more {
		font: inherit;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid #bfdbfe;
		background: #eff6ff;
		color: #1d4ed8;
		padding: 0.35rem 0.5rem;
		border-radius: 7px;
		text-align: center;
	}
	.exit-more:hover {
		background: #dbeafe;
		border-color: #93c5fd;
	}
	.exit-hint {
		font-size: 0.72rem;
		line-height: 1.4;
		color: #9aa0aa;
	}
</style>
