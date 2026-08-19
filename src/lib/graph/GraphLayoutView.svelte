<script lang="ts">
	// Reference-anchored "stringy" graph layout (ported from mini-web-viz-for-gfa).
	// Each segment is drawn as a strand whose length ∝ its sequence length; the
	// reference/backbone path is pinned to a straight horizontal line and variant
	// bubbles relax locally around it. The force layout runs in a Web Worker so a
	// dense subgraph never freezes the tab. Graph simplification happens upstream,
	// so this component just lays out and draws whatever graph it's given.
	import { onDestroy, untrack } from 'svelte';
	import { gfaStats, type Gfa } from '../gfa';
	import { limits } from '../limits.svelte';
	import { gfaToGraph } from './gfaToGraph';
	import type { GfaGraph } from './types';
	import type { LayoutResult, SimNode, SegmentChain } from './forceLayout';
	import type { LayoutRequest, LayoutResponse } from './layout.worker';
	import {
		LAYOUT_MODES,
		DEFAULT_LAYOUT_MODE,
		getModeConfig,
		type LayoutMode,
		type LayoutFamily
	} from './layoutModes';
	import GraphCanvas, { type CanvasSkip } from './GraphCanvas.svelte';
	import MsaPanel from './MsaPanel.svelte';
	import QueryReport from './QueryReport.svelte';
	import { computeBubbles } from './bubbles';
	import { COLOR_MODES, legendGradientCss, darkTheme, lightTheme, BACKBONE_COLOR, type ColorMode } from './colors';
	import { trackEvent } from '../analytics';
	import { transcriptsInRange, representativeTranscripts, type Transcript } from '../geneTrack';
	import type { RefKey } from '../genes';

	let {
		gfa,
		referenceSample = $bindable(),
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
		querying = false,
		showHaplotypes = false,
		initialLayoutMode,
		walkNoun = 'haplotype walks',
		backboneOptions = [],
		backboneNote = null,
		hasTraversals = true
	}: {
		gfa: Gfa;
		referenceSample: string;
		refKey?: RefKey;
		/** Selectable backbone/reference names. When more than one is given, the
		 * Reference-based layout options show a picker bound to `referenceSample`
		 * (the /gfa page, where the backbone is user-choosable). Empty on the hosted
		 * locus browser, whose reference is fixed — so no picker appears there. */
		backboneOptions?: string[];
		/** A one-line note shown in place of the picker when the backbone isn't a
		 * chosen reference — e.g. "computed longest path" or an rGFA reference. */
		backboneNote?: string | null;
		/** Whether the graph has real haplotype walks / paths to trace. False for a
		 * reference-less GFA whose only "walk" is the computed backbone: walk-tracing
		 * and walk-coverage colouring are meaningless there, so the walk hover mode
		 * shows a note and the default colouring avoids coverage. Defaults to true (the
		 * hosted locus browser, whose walks load on demand). */
		hasTraversals?: boolean;
		/** Layout mode to open on (before the user touches the control). The /gfa page
		 * uses this to start a no-reference graph in a reference-free mode. Omitted →
		 * the default anchored mode. */
		initialLayoutMode?: LayoutMode;
		/** What to call the traversals in the report — "haplotype walks" for the hosted
		 * locus browser's W-lines, "paths" for a P-line graph. `null` hides the count
		 * entirely (a computed-backbone graph has no real traversals to report). */
		walkNoun?: string | null;
		/** Show a panel listing the graph's named haplotype walks, where clicking one
		 * pins the disco spotlight onto that single haplotype's path (a paused disco
		 * trace). Off by default — the hosted locus browser's walks are anonymised, so
		 * this is only meaningful for a general GFA with real per-haplotype W-lines
		 * (the /gfa page). */
		showHaplotypes?: boolean;
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

	// The primary layout control: a named mode that picks a whole recipe (family +
	// all the per-mode force tuning, resolved in the worker). Persists across graphs
	// so the user can keep comparing the same view. See layoutModes.ts.
	// Seeded once from the prop (untracked — later prop changes shouldn't yank the
	// user's chosen mode out from under them); the control owns it from then on.
	let layoutMode = $state<LayoutMode>(untrack(() => initialLayoutMode) ?? DEFAULT_LAYOUT_MODE);
	const modeCfg = $derived(getModeConfig(layoutMode));
	// Reference-free modes have no backbone, so they show no coordinate axis and no
	// gene track (see the GraphCanvas props below).
	const referenceFree = $derived(modeCfg.family === 'free');

	// Whether this graph's traversals are P-line paths (vs W-line haplotypes), taken
	// from the report noun the parent passed. Drives the Haplotypes/Paths panel
	// wording so a GFA-1.0 path graph doesn't get mislabelled "haplotypes".
	const traversalsArePaths = $derived(walkNoun === 'paths');
	const panelHeader = $derived(traversalsArePaths ? 'Paths' : 'Haplotypes');
	const panelNoun = $derived(traversalsArePaths ? 'paths' : 'walks');

	// Switch layout family from the segmented control, landing on that family's
	// first mode (so "Reference-free" always has a sensible default selected).
	function selectFamily(fam: LayoutFamily) {
		if (modeCfg.family === fam) return;
		const first = LAYOUT_MODES.find((m) => m.family === fam);
		if (first) layoutMode = first.id;
	}

	// Mark strands chopped at the subgraph boundary with a fading cue toward the
	// frame edge (the direction the haplotype leaves the locus), so they don't read
	// as random dangles. Off for a clean figure.
	let showExits = $state(true);

	// The gene track drawn in a band under the backbone, inside the graph canvas. On
	// by default; switched off from the side panel.
	let showGeneTrack = $state(true);

	// What hovering a node does, on top of the always-on tooltip:
	//   'info'   — nothing extra (just the tooltip / click-to-inspect).
	//   'bubble' — light up every node of the bubble the hovered node belongs to,
	//              and show that bubble's shortest/longest path in the inspector.
	//   'walk'   — trace (disco-style) every haplotype walk that passes through the
	//              hovered node, each in its own colour.
	// Info by default so nothing extra is computed until asked — the two richer modes
	// build an index over the graph (and walk mode may load the full-walk graph), so
	// on a large locus they carry a slow-down warning (see hoverModeHeavy). This is
	// Graphoscope's general rule: show context by default unless it slows the app, and
	// then keep it one switch away with a warning.
	let hoverMode = $state<'none' | 'info' | 'bubble' | 'walk'>('info');
	// The strand currently under the pointer (reported by the canvas), which drives
	// the two hover modes. Independent of `selected` (a click), so highlighting
	// follows the pointer without pinning an inspector open.
	let hoveredNode = $state<string | null>(null);
	// Set once per graph when the user first asks for walk mode on a reduced graph, so
	// we request the full-walk graph exactly once rather than on every hover.
	let walkLoadRequested = $state(false);
	// A clicked skip-edge (deletion-only) bubble, reported by the canvas; it has no
	// drawn nodes, so it's tracked here rather than through `selected`.
	let selectedSkip = $state<CanvasSkip | null>(null);
	// The skip-edge bubble under the pointer (reported by the canvas).
	let hoveredSkip = $state<string | null>(null);

	// The two most-used controls (Simplify + disco) stay pinned; everything else
	// lives behind these sidebar tabs so the panel stays short as options grow.
	let ctlTab = $state<'layout' | 'view'>('layout');

	// Render the graph on a light theme (for figures/publication) instead of the
	// dark screen one. The export button below writes a PNG of the current view.
	let lightMode = $state(false);
	let canvasApi = $state<{
		exportImage: (filename: string) => void;
		colorForSegment: (segId: string) => string;
	} | null>(null);

	// What each node's fill encodes. Defaults to walk coverage (the original heatmap),
	// except on a graph with no real walks/paths — there every node's coverage is 0, so
	// the heatmap is a flat uniform colour; fall back to node length, which is always
	// meaningful. The picker lives in the on-graph legend at the foot of the canvas.
	let colorMode = $state<ColorMode>(untrack(() => hasTraversals) ? 'coverage' : 'length');
	const colorModeInfo = $derived(COLOR_MODES.find((m) => m.mode === colorMode) ?? COLOR_MODES[0]);
	// The graph's fill colour for a node, handed to the MSA colour track so it mirrors
	// the graph exactly. `colorMode`/`lightMode` are read only so this re-derives (and
	// the track redraws) when the "color by" setting or theme changes.
	const msaColorForSeg = $derived.by(() => {
		colorMode;
		lightMode;
		const api = canvasApi;
		return api ? (segId: string) => api.colorForSegment(segId) : undefined;
	});
	// The legend swatch is drawn from the same ramp the canvas uses, so it tracks the
	// light/dark theme (the picker itself sits on the app's light chrome regardless).
	const legendTheme = $derived(lightMode ? lightTheme : darkTheme);

	// Which fields to surface about a node — in the hover tooltip and in the floating
	// inspector opened by clicking one. Configured from the gear menu inside that
	// inspector. Sequence is off by default since it can be long.
	let showNodeId = $state(true);
	let showLength = $state(true);
	let showCoords = $state(true);
	let showSequence = $state(false);
	// Whether the inspector's field-settings popover (the gear menu) is open.
	let nodeFieldsOpen = $state(false);

	let selected = $state<string | null>(null);

	// The base-alignment (MSA) view: a resizable split below the graph showing the
	// reference plus the haplotypes through the selected node, aligned base-by-base.
	// Opened from the node inspector; stays open and re-derives as the selection
	// changes, so a user can click node after node and watch the alignment update.
	let msaOpen = $state(false);
	let msaHeight = $state(360);
	// When "Load MSA" is clicked on a simplified graph, we switch to the full graph
	// (which carries the walks the alignment needs). That swap fires the graph-reset
	// effect below, which would normally close the MSA and drop the selection — so we
	// stash the full-graph node to focus on here, and the reset effect re-opens the MSA
	// on it once the full graph arrives. Holds an *original* node id (a member of the
	// clicked reduced node), which is what the full graph is keyed by.
	let pendingMsaNode = $state<string | null>(null);
	// Short local names (R1/A1/…) the MSA assigns to the nodes in its window, so the
	// graph can label the same nodes; null when simplified names are off/closed.
	let msaNames = $state<Map<string, string> | null>(null);
	// A node clicked in the MSA gets flashed in the graph so the user can spot it.
	// `flashNonce` bumps on every click so re-clicking the same node re-triggers.
	let flashSegment = $state<string | null>(null);
	let flashNonce = $state(0);
	function flashGraphNode(segId: string) {
		flashSegment = segId;
		flashNonce++;
	}
	// Walks the user clicked in the MSA rows: each is traced (disco-style) in the graph
	// in its own colour, and that colour is echoed back onto the MSA row label. Cleared
	// on a new graph (its walk keys won't carry over).
	let msaWalkKeys = $state<string[]>([]);
	function toggleMsaWalk(key: string) {
		msaWalkKeys = msaWalkKeys.includes(key)
			? msaWalkKeys.filter((k) => k !== key)
			: [...msaWalkKeys, key];
	}
	/** Find a walk by its `sample#hap#seq` key in the walk-bearing graph (the MSA rows
	 * use the same key format). Falls back to the displayed graph. */
	function findWalkByKey(key: string): { steps: { id: string; orient: '+' | '-' }[] } | null {
		const src = walksGfa ?? gfa;
		for (const w of src.walks) {
			if (w.kind === 'synthetic') continue;
			if (`${w.sample}#${w.hapIndex}#${w.seqId}` === key) return w;
		}
		return null;
	}
	const msaWalkColor = (key: string) => colorForSeed(Math.max(0, msaWalkKeys.indexOf(key)));
	// The traces the MSA-clicked walks add to the graph overlay.
	const msaWalkPaths = $derived.by((): { path: DiscoStep[]; color: string }[] => {
		const out: { path: DiscoStep[]; color: string }[] = [];
		for (const key of msaWalkKeys) {
			const w = findWalkByKey(key);
			const p = w ? projectWalk(w.steps) : null;
			if (p) out.push({ path: p, color: msaWalkColor(key) });
		}
		return out;
	});
	// Walk key → highlight colour for every walk currently spotlit in the graph, so the
	// MSA can echo the colour on the matching row. Covers MSA-clicked walks plus any
	// haplotype-panel pins/hover that happen to be lit.
	const msaRowHighlights = $derived.by((): Map<string, string> => {
		const m = new Map<string, string>();
		for (const key of msaWalkKeys) m.set(key, msaWalkColor(key));
		for (const w of pinnedWalks) m.set(w.key, colorForKey(w.key));
		if (hoverWalk) m.set(hoverWalk.key, colorForKey(hoverWalk.key));
		return m;
	});
	function startMsaResize(e: PointerEvent) {
		e.preventDefault();
		const startY = e.clientY;
		const startH = msaHeight;
		const onMove = (ev: PointerEvent) => {
			// Drag up grows the panel; clamp so neither the graph nor the panel vanish.
			msaHeight = Math.max(160, Math.min(720, startH + (startY - ev.clientY)));
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// The node the highlighting is keyed to: the one under the pointer while hovering,
	// otherwise the clicked (selected) one. So a click *freezes* the highlight — you
	// can move off the node and pan/zoom around with the bubble or its walks still lit,
	// exploring what's connected — and hovering another node previews it live. The skip
	// equivalent works the same way (hoveredSkip ?? selectedSkip's key).
	const activeNode = $derived(hoveredNode ?? selected);
	// The skip whose arc is spotlit in the graph. Only in bubble mode, where the whole
	// bubble reads as one lit unit against a dimmed graph; in walk mode a skip instead
	// traces its walks (below), so we don't dim there.
	const activeSkipKey = $derived(
		hoverMode === 'bubble' ? (hoveredSkip ?? selectedSkip?.key ?? null) : null
	);
	// The inspector's × just hides the box; it doesn't clear the selection, so the
	// frozen bubble/walk highlight stays lit (the box was covering the view). Any new
	// selection re-opens it; clicking empty graph clears the selection entirely.
	let inspectorDismissed = $state(false);

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

	// A clicked off-locus exit cue (a dashed strand leaving the subgraph), shown in
	// the same inspector.
	interface SelectedExit {
		segId: string;
		side: 'left' | 'right';
	}
	let selectedExit = $state<SelectedExit | null>(null);

	$effect(() => {
		gfa;
		// Depend on `gfa` ALONE. The body reads/writes `pendingMsaNode` and other state;
		// left tracked, reading `pendingMsaNode` would make setting it (in the Load-MSA
		// handler) fire this effect immediately — while the graph is still reduced — and
		// clear it before the switch lands. Untrack keeps the graph swap the only trigger.
		untrack(() => {
			// A "Load MSA" switch to the full graph: instead of dropping everything, re-open
			// the alignment on the corresponding full-graph node. Guarded on !gfa.reduced so
			// it only fires once the full graph has actually arrived.
			const resuming = pendingMsaNode != null && !gfa.reduced;
			if (resuming) {
				selected = gfa.segments.has(pendingMsaNode!) ? pendingMsaNode : null;
				msaOpen = selected != null;
			} else {
				selected = null;
				// A new graph has different nodes; close the base-alignment view rather than
				// leaving it pinned to a node id that no longer exists.
				msaOpen = false;
			}
			pendingMsaNode = null;
			inspectorDismissed = false;
			selectedFeature = null;
			selectedExit = null;
			// A new graph clears any pinned haplotype traces (its walk keys won't exist).
			pinnedKeys = [];
			// …and any walks spotlit from the MSA (same reason).
			msaWalkKeys = [];
			straightenKey = null;
			// …and any node-restricted haplotype filter (node ids won't carry over).
			nodeFilter = null;
			// A new graph gets a fresh automatic bendy/rough decision (see effectiveBendy)
			// and drops any per-graph layout overrides back to the mode's defaults.
			bendyOverride = null;
			// …and a fresh chance to surface the slow-layout tip for the new graph.
			slowTipDismissed = false;
			// Hover highlighting doesn't carry across graphs (node ids won't match), and the
			// walk-graph load is per-graph.
			hoveredNode = null;
			hoveredSkip = null;
			selectedSkip = null;
			walkLoadRequested = false;
		});
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
			if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
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
	// The endpoints panel (walks starting/ending here) carries its own "Increase
	// context & re-query" button plus the fuller explanation, so when it's showing
	// the bubble/walk exit notes above it drop their duplicate button and keep just
	// the note text.
	const hasEndpointSection = $derived(!!endpointCounts || endpoints.length > 0);

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
			if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
			if (w.steps.length < 2) continue; // a single node isn't a path to trace
			// When a node filter is active (set from the node inspector), disco cycles
			// only the walks that actually pass through that node.
			if (nodeFilter && !walkThroughNode(w.steps, nodeFilter)) continue;
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

	// Whether a walk's steps pass through a given displayed node. Steps are mapped
	// through origToDisplayed so a click on a merged u-chain still matches the
	// original nodes it swallowed (identity on the full /gfa graph).
	function walkThroughNode(steps: { id: string; orient: '+' | '-' }[], nodeId: string): boolean {
		for (const s of steps) if (origToDisplayed.get(s.id) === nodeId) return true;
		return false;
	}

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

	// --- named haplotypes (the /gfa page) ---------------------------------------
	// The graph's walks with their real names kept, so a user can pick one and trace
	// just that haplotype. Unlike `discoWalks` (deduped by trace, anonymous), this
	// keeps every distinct named W-line so haplotypes sharing a path still each
	// appear. Only built when `showHaplotypes` is on.
	interface NamedWalk {
		key: string;
		sample: string;
		hapIndex: number;
		seqId: string;
		/** What the row shows: the real sample name, or "Walk N" for the anonymised
		 * `unknown` walks a gbz-base subgraph extract produces (the hosted locus
		 * browser), where every walk is `unknown` and only an ordinal tells them apart.
		 * "Walk", not "Haplotype", because several of these walks can belong to the
		 * same haplotype (one haplotype fragmented across W-lines). */
		label: string;
		span: number;
		steps: { id: string; orient: '+' | '-' }[];
	}
	const namedWalks = $derived.by((): NamedWalk[] => {
		if (!showHaplotypes) return [];
		const src = walksGfa;
		if (!src) return [];
		const out: NamedWalk[] = [];
		const seen = new Set<string>();
		let anonCount = 0;
		for (const w of src.walks) {
			if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
			if (w.steps.length < 2) continue;
			const key = `${w.sample}#${w.hapIndex}#${w.seqId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const anon = w.sample === 'unknown';
			if (anon) anonCount++;
			out.push({
				key,
				sample: w.sample,
				hapIndex: w.hapIndex,
				seqId: w.seqId,
				label: anon ? `Walk ${anonCount}` : w.sample,
				span: w.end - w.start,
				steps: w.steps
			});
		}
		return out;
	});
	// Haplotypes the user has pinned by clicking rows: each is traced at once, in its
	// own colour, so several can be compared side by side. Cleared on a new graph and
	// when cycling disco starts.
	let pinnedKeys = $state<string[]>([]);
	// The one haplotype the layout straightens into a horizontal track above the
	// reference (see the straightenPath layout option). Distinct from `pinnedKeys`
	// (a colour-only comparison set): straighten reshapes the layout, so only one
	// walk can hold it. Cleared on a new graph and when its key drops out of the list.
	let straightenKey = $state<string | null>(null);
	let haploFilter = $state('');
	// A displayed node id the haplotype list is restricted to, set from the node
	// inspector's "haplotypes through this node" button. Independent of `selected`,
	// so it survives closing the inspector; cleared from the panel or on a new graph.
	let nodeFilter = $state<string | null>(null);
	// The named walks passing through the filter node (all of them when no filter).
	const throughNodeWalks = $derived.by(() =>
		nodeFilter ? namedWalks.filter((w) => walkThroughNode(w.steps, nodeFilter!)) : namedWalks
	);
	const filteredNamedWalks = $derived.by(() => {
		const base = throughNodeWalks;
		const q = haploFilter.trim().toLowerCase();
		if (!q) return base;
		return base.filter((w) => `${w.sample} ${w.seqId} hap ${w.hapIndex}`.toLowerCase().includes(q));
	});
	// Count of named walks through the currently-selected node — drives the label on
	// the inspector button (only computed while a node is selected and the list is on).
	const selectedThroughCount = $derived(
		showHaplotypes && selected ? namedWalks.filter((w) => walkThroughNode(w.steps, selected!)).length : 0
	);
	const pinnedWalks = $derived(
		pinnedKeys
			.map((k) => namedWalks.find((w) => w.key === k))
			.filter((w): w is NamedWalk => w != null)
	);
	// Transient hover preview: pointing at a haplotype row traces it without pinning,
	// so you can skim the list and see each path light up. Takes visual precedence
	// over pins/cycle while the pointer is on the row; clears on leave.
	let hoverKey = $state<string | null>(null);
	const hoverWalk = $derived(hoverKey ? (namedWalks.find((w) => w.key === hoverKey) ?? null) : null);

	// A stable colour per haplotype, keyed to its position in the list so a given
	// haplotype keeps its colour whether hovered, pinned, or cycled.
	function colorForSeed(seed: number): string {
		return `hsl(${(seed * 47) % 360}, 95%, ${lightMode ? 45 : 62}%)`;
	}
	function colorForKey(key: string): string {
		const i = namedWalks.findIndex((w) => w.key === key);
		return colorForSeed(i >= 0 ? i : 0);
	}

	function togglePin(key: string) {
		if (pinnedKeys.includes(key)) {
			pinnedKeys = pinnedKeys.filter((k) => k !== key);
			return;
		}
		// Add to the comparison set; pins and auto-cycling are mutually exclusive.
		pinnedKeys = [...pinnedKeys, key];
		disco = false;
		pendingDisco = false;
		trackEvent('widget_interact', { widget: 'graph_layout', action: 'haplotype_trace' });
	}

	// Straighten the chosen walk into a horizontal track above the reference (radio:
	// clicking the active one clears it). Stops auto-cycling — a moving spotlight over
	// a straightened track reads as noise.
	function toggleStraighten(key: string) {
		straightenKey = straightenKey === key ? null : key;
		if (straightenKey) {
			disco = false;
			pendingDisco = false;
			trackEvent('widget_interact', { widget: 'graph_layout', action: 'haplotype_straighten' });
		}
	}
	// Drop the straighten selection if its walk is no longer in the list (e.g. the
	// list rebuilt after a graph swap, or a node filter that excludes it).
	$effect(() => {
		if (straightenKey && !namedWalks.some((w) => w.key === straightenKey)) straightenKey = null;
	});
	// The chosen walk projected onto the displayed segments, in traversal order —
	// the layout's straightenPath. Recomputed when the selection or graph changes.
	const straightenPath = $derived.by((): DiscoStep[] | null => {
		if (!straightenKey) return null;
		const w = namedWalks.find((x) => x.key === straightenKey);
		return w ? projectWalk(w.steps) : null;
	});
	const straightenLabel = $derived(
		straightenKey ? (namedWalks.find((w) => w.key === straightenKey)?.label ?? 'walk') : ''
	);

	let disco = $state(false);
	let pendingDisco = $state(false);
	let discoIndex = $state(0);

	function toggleDisco() {
		if (disco) {
			disco = false;
			return;
		}
		// Cycling clears the pinned comparison traces, but keeps any straightened
		// layout: it's the point — lay the graph out along one walk, then watch every
		// other walk blink through that arrangement.
		pinnedKeys = [];
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

	// The auto-cycling disco walk, if running (one step of the cycle at a time).
	const currentDiscoWalk = $derived(
		disco && discoWalks.length > 0 ? discoWalks[discoIndex % discoWalks.length] : null
	);
	// Project a walk onto the displayed segments: map each step through
	// origToDisplayed, drop steps with no representative here (popped), and collapse
	// a run of steps that all landed in the same displayed segment into one.
	function projectWalk(steps: { id: string; orient: '+' | '-' }[]): DiscoStep[] | null {
		const out: DiscoStep[] = [];
		let lastId: string | null = null;
		for (const step of steps) {
			const id = origToDisplayed.get(step.id);
			if (!id || id === lastId) continue;
			out.push({ id, orient: step.orient });
			lastId = id;
		}
		return out.length > 0 ? out : null;
	}
	interface DiscoStep {
		id: string;
		orient: '+' | '-';
	}
	// The set of coloured paths the canvas draws. Priority: a hover preview (single),
	// then — while disco is cycling — the blinking walk (so straighten + disco shows
	// every walk sweeping through the straightened layout), otherwise the pinned
	// comparison set plus the straightened track's own colour.
	const discoPaths = $derived.by((): { path: DiscoStep[]; color: string }[] => {
		if (hoverWalk) {
			const p = projectWalk(hoverWalk.steps);
			return p ? [{ path: p, color: colorForKey(hoverWalk.key) }] : [];
		}
		if (currentDiscoWalk) {
			const p = projectWalk(currentDiscoWalk.steps);
			return p ? [{ path: p, color: colorForSeed(discoIndex) }] : [];
		}
		const out: { path: DiscoStep[]; color: string }[] = [];
		for (const w of pinnedWalks) {
			const p = projectWalk(w.steps);
			if (p) out.push({ path: p, color: colorForKey(w.key) });
		}
		// Always colour the straightened track (unless it's already pinned), so the
		// walk the layout reshaped around is easy to pick out from the floating rest.
		if (straightenKey && !pinnedKeys.includes(straightenKey) && straightenPath) {
			out.push({ path: straightenPath, color: colorForKey(straightenKey) });
		}
		return out;
	});
	// --- walk mode: walks through the hovered node or deletion arc --------------
	// Index every displayed segment to the walks that pass through it (mapping each
	// walk's original node ids onto the displayed segments via origToDisplayed), plus
	// each skip (deletion) edge to the walks that *take* it — a walk takes a skip when
	// its projected path steps straight from the skip's `from` node to its `to` node
	// (walks don't name edges, but a traversed edge is just two consecutive steps).
	// Both are built in one pass over `walksGfa` (the full-walk graph, loaded on demand)
	// when walk mode turns on, so a hover is an O(1) lookup instead of a re-scan.
	const MAX_WALK_HOVER_PATHS = 48; // cap the glowing overlays so a hover stays smooth
	// Displayed node pair "a>b" (either orientation) -> the skip edge it is.
	const skipEdgeLookup = $derived.by((): Map<string, string> => {
		const m = new Map<string, string>();
		if (hoverMode !== 'walk') return m;
		for (const s of skipBubbles) {
			m.set(`${s.from}>${s.to}`, s.key);
			m.set(`${s.to}>${s.from}`, s.key);
		}
		return m;
	});
	const walkIndex = $derived.by(() => {
		const byNode = new Map<string, { id: string; orient: '+' | '-' }[][]>();
		const bySkip = new Map<string, DiscoStep[][]>();
		if (hoverMode !== 'walk' || !walksGfa) return { byNode, bySkip };
		for (const w of walksGfa.walks) {
			if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
			if (w.steps.length < 2) continue;
			// File the walk under every displayed segment it touches (deduped).
			const touched = new Set<string>();
			for (const s of w.steps) {
				const d = origToDisplayed.get(s.id);
				if (d) touched.add(d);
			}
			for (const d of touched) {
				let arr = byNode.get(d);
				if (!arr) byNode.set(d, (arr = []));
				arr.push(w.steps);
			}
			// …and under every skip edge its projected path traverses.
			if (skipEdgeLookup.size > 0) {
				const p = projectWalk(w.steps);
				if (p && p.length >= 2) {
					let matched: Set<string> | null = null;
					for (let i = 0; i + 1 < p.length; i++) {
						const key = skipEdgeLookup.get(`${p[i].id}>${p[i + 1].id}`);
						if (key) (matched ??= new Set()).add(key);
					}
					if (matched)
						for (const k of matched) {
							let arr = bySkip.get(k);
							if (!arr) bySkip.set(k, (arr = []));
							arr.push(p);
						}
				}
			}
		}
		return { byNode, bySkip };
	});

	// What walk mode is currently tracing: a hovered target takes precedence over a
	// clicked (frozen) one, and a skip over a node when both are under the pointer.
	type WalkTarget = { type: 'node'; id: string } | { type: 'skip'; key: string } | null;
	const walkTarget = $derived.by((): WalkTarget => {
		if (hoverMode !== 'walk') return null;
		if (hoveredSkip) return { type: 'skip', key: hoveredSkip };
		if (hoveredNode) return { type: 'node', id: hoveredNode };
		// While disco is cycling, don't keep the *frozen* (clicked) selection lit —
		// its static walk highlight would sit on top of and hide the disco spotlight.
		// A live hover above still previews, so you can still inspect during disco.
		if (disco) return null;
		if (selectedSkip) return { type: 'skip', key: selectedSkip.key };
		if (selected) return { type: 'node', id: selected };
		return null;
	});

	// Dedupe a list of walk traces (a repetitive locus files many identical ones),
	// colour them, and cap the count so a hover stays smooth.
	function traceOverlays(paths: (DiscoStep[] | null)[]): { path: DiscoStep[]; color: string }[] {
		const out: { path: DiscoStep[]; color: string }[] = [];
		const seen = new Set<string>();
		for (const p of paths) {
			if (!p || p.length === 0) continue;
			const key = p.map((s) => s.id).join('>');
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ path: p, color: colorForSeed(out.length) });
			if (out.length >= MAX_WALK_HOVER_PATHS) break;
		}
		return out;
	}
	function countTraces(paths: (DiscoStep[] | null)[]): number {
		const seen = new Set<string>();
		for (const p of paths) if (p && p.length > 0) seen.add(p.map((s) => s.id).join('>'));
		return seen.size;
	}
	// Projected traces for a target — node walks are projected here; skip walks were
	// already projected when the index was built (that's how the edge was detected).
	function tracesFor(target: WalkTarget): (DiscoStep[] | null)[] {
		if (!target) return [];
		if (target.type === 'skip') return walkIndex.bySkip.get(target.key) ?? [];
		return (walkIndex.byNode.get(target.id) ?? []).map((steps) => projectWalk(steps));
	}

	const walkHoverPaths = $derived(
		hoverMode === 'walk' ? traceOverlays(tracesFor(walkTarget)) : []
	);
	const activeWalkCount = $derived(hoverMode === 'walk' ? countTraces(tracesFor(walkTarget)) : 0);
	// Counts for the inspectors of a clicked node / clicked skip.
	const selectedWalkCount = $derived(
		hoverMode === 'walk' && selected ? countTraces(tracesFor({ type: 'node', id: selected })) : 0
	);
	const selectedSkipWalkCount = $derived(
		hoverMode === 'walk' && selectedSkip
			? countTraces(tracesFor({ type: 'skip', key: selectedSkip.key }))
			: 0
	);

	// Whether to load the full-walk graph automatically, offer a button, or refuse
	// it as a memory risk is decided from the reduced graph's own stats, all in the
	// shared `limits` module (device- and memory-aware — see limits.svelte.ts). The
	// full graph is ~97% walks (tens of MB at a repetitive locus), and it's the
	// *parsed* walks that can OOM a phone tab, so the ceilings scale with the device.
	// Full-graph size estimate from the reduced `X` line (0 when not a reduced graph).
	const fullGraphNodes = $derived(gfa.reduced?.segmentsBefore ?? 0);
	// Number of haplotype walks in the full graph — what the "load haplotypes"
	// button actually fetches (the walks are ~97% of the payload). Distinct from
	// `fullGraphNodes`: loading them doesn't change the node count on screen.
	const fullGraphWalks = $derived(gfa.reduced?.totalWalks ?? 0);
	// 'auto' → load without asking; 'manual' → load on a click; 'risky' → big
	// enough to threaten an OOM (refused on a memory-constrained device).
	const walkLoadTier = $derived(limits.walkLoadTier(gfa.reduced));
	const haploDataLight = $derived(fullGraphNodes > 0 && walkLoadTier === 'auto');
	// On a phone, a repetitive locus (LPA and the like) can crash the tab when its
	// walks are parsed. There we don't offer to load them at all — avoiding the
	// crash matters more than the feature. Desktop still allows it with a caution.
	const walkLoadBlocked = $derived(walkLoadTier === 'risky' && limits.lowMemory);

	// Walk mode needs the full-walk graph. On a reduced graph that means asking the
	// parent to load it once (the same fetch disco uses); on a graph that already
	// carries walks it's ready immediately.
	const walkModeNeedsLoad = $derived(hoverMode === 'walk' && !walksGfa);
	$effect(() => {
		if (
			hoverMode === 'walk' &&
			!walksGfa &&
			discoAvailable &&
			!discoLoading &&
			!walkLoadRequested &&
			!walkLoadBlocked
		) {
			walkLoadRequested = true;
			onRequestDiscoGraph?.();
		}
	});

	// What the canvas actually spotlights: in walk mode a live hover supersedes the
	// disco/haplotype traces; otherwise the existing disco paths. MSA-clicked walk
	// traces are always layered on, so a walk picked in the alignment stays lit.
	const overlayPaths = $derived([
		...(hoverMode === 'walk' && walkHoverPaths.length > 0 ? walkHoverPaths : discoPaths),
		...msaWalkPaths
	]);
	const traceActive = $derived(overlayPaths.length > 0);
	// Show the button whenever disco is either already possible or loadable.
	const showDiscoButton = $derived(canDiscoNow || discoAvailable || disco || pendingDisco);

	// The Haplotypes box holds both the disco spotlight and the per-walk list. Before
	// the full-walk graph is fetched (hosted browser), the list can still be loaded on
	// demand; `showHaploBox` keeps the box up whenever any of that is available.
	const canLoadHaplos = $derived(
		walksGfa == null && (discoAvailable || discoLoading || walkLoadRequested)
	);
	const showHaploBox = $derived(
		showHaplotypes &&
			(showDiscoButton || namedWalks.length > 0 || canLoadHaplos || walkLoadBlocked)
	);

	$effect(() => {
		if (
			showHaplotypes &&
			walksGfa == null &&
			discoAvailable &&
			!discoLoading &&
			!walkLoadRequested &&
			haploDataLight
		) {
			walkLoadRequested = true;
			onRequestDiscoGraph?.();
		}
	});

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

	// --- bubble mode: node → the bubble it belongs to ---------------------------
	// Bubbles: everything that departs from the reference and survives simplification
	// — a connected component of non-reference segments, or a skip edge (see
	// bubbles.ts). Computed straight from the reduced graph the canvas draws, so each
	// is anchored at the reference coordinates where it attaches and carries the
	// shortest and longest path (bp) through it. Built in bubble mode (the node→bubble
	// map) and in walk mode (skip edges, so a deletion arc can be traced), but not for
	// a plain info-mode view of a large graph.
	const bubbleModel = $derived.by(() => {
		if (hoverMode !== 'bubble' && hoverMode !== 'walk') return null;
		return computeBubbles(gfa, referenceSample);
	});

	// --- node coloring: bubble-based color modes --------------------------------
	// The two bubble color modes (discrete `bubble` and the `bubbleSize` heatmap)
	// need the same bubble catalogue, computed independently of the hover mode.
	// Reuse `bubbleModel` when a bubble hover mode already built it; otherwise build
	// it here, only while a bubble color mode is actually selected.
	const colorBubbleModel = $derived.by(() => {
		if (colorMode !== 'bubble' && colorMode !== 'bubbleSize') return null;
		if (bubbleModel) return bubbleModel;
		return computeBubbles(gfa, referenceSample);
	});
	// segId → bubble index (discrete color) and segId → the longest bp path through
	// its bubble (size heatmap). Bubbles are ordered by reference position in the
	// model, so the discrete hues fall in a stable left-to-right sequence.
	const bubbleIdBySeg = $derived.by((): Map<string, number> | null => {
		if (colorMode !== 'bubble' || !colorBubbleModel) return null;
		const m = new Map<string, number>();
		colorBubbleModel.bubbles.forEach((b, i) => {
			for (const id of b.nodeIds) m.set(id, i);
		});
		return m;
	});
	const bubbleLongestBySeg = $derived.by((): Map<string, number> | null => {
		if (colorMode !== 'bubbleSize' || !colorBubbleModel) return null;
		const m = new Map<string, number>();
		for (const b of colorBubbleModel.bubbles) {
			for (const id of b.nodeIds) m.set(id, b.longest);
		}
		return m;
	});
	const maxBubbleLongest = $derived(
		colorMode === 'bubbleSize' && colorBubbleModel
			? colorBubbleModel.bubbles.reduce((mx, b) => Math.max(mx, b.longest), 0)
			: 0
	);

	// Maps every non-reference segment id to its bubble, so hovering (or selecting)
	// any one node can light up the whole bubble and read out its path extremes.
	interface NodeBubble {
		segIds: Set<string>;
		shortest: number;
		longest: number;
		refSpan: number;
		nodeCount: number;
		coverage: number;
		contig: string;
		gStart: number;
		gEnd: number;
	}
	const nodeToBubble = $derived.by((): Map<string, NodeBubble> => {
		const m = new Map<string, NodeBubble>();
		if (hoverMode !== 'bubble' || !bubbleModel) return m;
		const model = bubbleModel;
		for (const b of model.bubbles) {
			if (b.nodeIds.length === 0) continue; // a bare skip has no drawn nodes
			const nb: NodeBubble = {
				segIds: new Set(b.nodeIds),
				shortest: b.shortest,
				longest: b.longest,
				refSpan: b.refSpan,
				nodeCount: b.nodeCount,
				coverage: b.coverage,
				contig: model.contig,
				gStart: model.genomicStart + b.entryBp,
				gEnd: model.genomicStart + b.exitBp
			};
			for (const id of b.nodeIds) m.set(id, nb);
		}
		return m;
	});
	// The set of segments to spotlight in the graph: the active node's whole bubble.
	const bubbleHighlight = $derived.by((): Set<string> | null => {
		if (hoverMode !== 'bubble' || !activeNode) return null;
		return nodeToBubble.get(activeNode)?.segIds ?? null;
	});
	// The bubble of the *clicked* node, shown in the node inspector.
	const selectedBubble = $derived(
		hoverMode === 'bubble' && selected ? (nodeToBubble.get(selected) ?? null) : null
	);

	// Deletion-only (skip) bubbles: no drawn nodes, so they're handed to the canvas to
	// make their structural-link arc hoverable/clickable and inspectable like the rest.
	// Available in bubble mode (to inspect) and walk mode (to trace the walks that take
	// the deletion).
	const skipBubbles = $derived.by((): CanvasSkip[] => {
		if ((hoverMode !== 'bubble' && hoverMode !== 'walk') || !bubbleModel) return [];
		const model = bubbleModel;
		return model.bubbles
			.filter((b) => b.isSkip)
			.map((b) => ({
				key: `${b.linkFrom}>${b.linkTo}`,
				from: b.linkFrom,
				to: b.linkTo,
				refSpan: b.refSpan,
				coverage: b.coverage,
				contig: model.contig,
				gStart: model.genomicStart + b.entryBp,
				gEnd: model.genomicStart + b.exitBp
			}));
	});

	// --- off-locus exits: which highlighted strands leave the fetched window --------
	// The canvas reports every displayed segment that has an exit cue (a chopped
	// strand); we intersect that with the active bubble/walk to (a) tell the canvas
	// which cues to light up and (b) note it in the inspector.
	let exitSegIds = $state<Set<string>>(new Set());
	// Displayed segments the active highlight covers — the bubble's members, or the
	// segments the traced walks pass through — so the canvas can brighten their exit
	// cues. Only the ones that actually have a cue end up emphasised (canvas-side).
	const exitHighlightSegments = $derived.by((): Set<string> | null => {
		if (hoverMode === 'bubble') return bubbleHighlight;
		if (hoverMode === 'walk' && walkHoverPaths.length > 0) {
			const s = new Set<string>();
			for (const { path } of walkHoverPaths) for (const step of path) s.add(step.id);
			return s;
		}
		return null;
	});
	// Whether the clicked node's bubble / walks include a strand that leaves the locus.
	const selectedBubbleExits = $derived(
		selectedBubble ? [...selectedBubble.segIds].some((id) => exitSegIds.has(id)) : false
	);
	const selectedWalkExits = $derived.by(() => {
		if (hoverMode !== 'walk' || !selected || exitSegIds.size === 0) return false;
		const walks = walkIndex.byNode.get(selected);
		if (!walks) return false;
		for (const steps of walks) {
			const p = projectWalk(steps);
			if (p && p.some((s) => exitSegIds.has(s.id))) return true;
		}
		return false;
	});

	// "Bendy nodes" = the full-detail layout, where each segment relaxes into a
	// curved strand. It costs ~5 ms/node, so on a large graph it's dropped for the
	// ~0.55 ms/node rough layout (one straight node per segment). Small graphs get
	// it automatically; the Bendy-nodes switch lets the user force it either way.
	// `bendyOverride`: null = follow the automatic decision, true/false = a manual
	// override. Reset to null on every new graph so it re-decides per query.
	const autoBendy = $derived(adapted.keptSegments <= limits.roughLayoutNodes);
	let bendyOverride = $state<boolean | null>(null);
	const effectiveBendy = $derived(bendyOverride ?? autoBendy);

	// Warn "this can take a bit" only for genuinely heavy layouts, well above the
	// point where rough mode kicks in — rough keeps even a ~10k-node graph to a
	// handful of seconds (measured ~5–6 s on a 9,892-node fixture). The phone bar is
	// lower (see limits): a slow layout there also means more time holding memory.
	const showSlowLayoutWarning = $derived(adapted.keptSegments > limits.slowLayoutWarnNodes);

	// Past this the hover modes build a noticeably heavy index (and walk mode also
	// loads the full-walk graph), so the mode control warns before switching. The
	// modes still stay off by default (info) on every graph — this only softens the
	// opt-in on a big locus, per the "context by default, warn on slow-down" rule.
	const hoverModeHeavy = $derived(adapted.keptSegments > limits.hoverHeavyNodes);

	// Live slowness tip: react to the layout time we actually measured, not a node
	// count — the clock already reflects the device, so a slow machine trips this at
	// a smaller graph on its own. When the finished layout ran long AND there's a
	// cheaper option in reach, surface one dismissible suggestion pointing straight
	// at the lever. Reset per graph (see the new-graph block above).
	let slowTipDismissed = $state(false);
	const slowLayoutTip = $derived.by((): { text: string; action: null | (() => void); cta: string } | null => {
		if (slowTipDismissed || computing || !layoutIsCurrent) return null;
		if (ms <= limits.slowLayoutMs) return null;
		const secs = `${Math.round(ms / 1000)} s`;
		// Most direct lever first. Bendy detail on a big graph is the biggest win.
		if (effectiveBendy && adapted.keptSegments > limits.roughLayoutNodes) {
			return {
				text: `Layout took ${secs}. Bendy nodes is on — turning it off redraws almost instantly.`,
				cta: 'Turn off Bendy nodes',
				action: () => (bendyOverride = false)
			};
		}
		if (showingAllNodes) {
			return {
				text: `Layout took ${secs} on the full graph.`,
				cta: 'Back to simplified',
				action: () => onToggleSimplify?.()
			};
		}
		if (hoverMode === 'walk' || hoverMode === 'bubble') {
			return {
				text: `Layout took ${secs}. Heavy hover modes add to it.`,
				cta: 'Set hover to Info',
				action: () => (hoverMode = 'info')
			};
		}
		return {
			text: `Layout took ${secs} — a wide or repetitive locus. A narrower window redraws faster.`,
			cta: '',
			action: null
		};
	});

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
		mode: LayoutMode;
		// The bendy (full-detail) decision: null = auto, true/false = manual override.
		// The effective decision folds in each graph's own node count inside
		// layoutOptionsFor.
		bendyOverride: boolean | null;
		// The chosen haplotype straightened above the reference, or null. Included here
		// so picking/clearing it re-runs the layout (it changes node positions).
		straightenPath: DiscoStep[] | null;
	}
	const layoutKnobs = $derived<LayoutKnobs>({ mode: layoutMode, bendyOverride, straightenPath });

	// Worker options for a graph of this size. The mode carries the whole recipe —
	// the worker resolves every force knob from it (see layoutModes.ts / forceLayout)
	// — so all we add here is the reference sample and the bendy/rough decision.
	// Rough (not bendy: past the threshold unless overridden) collapses each segment
	// to one straight node and cuts iterations — the much faster layout (see the
	// 62.5s→6.0s note); bendy applies the mode's full-quality settings.
	function layoutOptionsFor(keptSegments: number, knobs: LayoutKnobs): LayoutRequest['options'] {
		const { mode, bendyOverride, straightenPath } = knobs;
		const bendy = bendyOverride ?? keptSegments <= limits.roughLayoutNodes;
		const base = { referenceSample, mode, straightenPath: straightenPath ?? undefined };
		return bendy
			? base
			: { ...base, maxEdgesPerSegment: 1, targetTotalSubNodes: 400, iterations: 60, bendNodes: false };
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
		if (showCoords && !referenceFree) {
			const c = refCoords.get(segId);
			if (c) parts.push(fmtCoord(c));
		}
		if (showSequence && seg?.seq) {
			parts.push(seg.seq.length > 40 ? `${seg.seq.slice(0, 40)}…` : seg.seq);
		}
		// When this node carries a short MSA name (R1/A1…) shown on it, explain what
		// that pill is and where to toggle it.
		if (msaNames?.has(segId)) {
			parts.push(`${msaNames.get(segId)} — short node ID, see MSA panel settings`);
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
				{walkNoun}
			/>

			<div class="ctl-wrap" class:dimmed={reportBusy}>
			<!-- Live slowness tip: appears only after a layout that actually ran long,
			     pointing at the cheapest lever available. Dismissible; one per graph. -->
			{#if slowLayoutTip}
				<div class="slow-tip" role="status">
					<span class="slow-tip-text">{slowLayoutTip.text}</span>
					<div class="slow-tip-actions">
						{#if slowLayoutTip.action}
							<button
								class="slow-tip-cta"
								onclick={() => {
									slowLayoutTip.action?.();
									slowTipDismissed = true;
								}}>{slowLayoutTip.cta}</button
							>
						{/if}
						<button
							class="slow-tip-dismiss"
							onclick={() => (slowTipDismissed = true)}
							aria-label="Dismiss">Dismiss</button
						>
					</div>
				</div>
			{/if}
			<!-- Pinned primary controls: the two most-reached-for switches. Only the
			     hosted locus browser has these (Simplify needs the full/reduced graph
			     swap), so on a plain GFA the whole group is dropped rather than left as
			     an empty box. -->
			{#if discoAvailable || showingAllNodes || allNodesTooMany}
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
					<span class="switch-sub note"
						>{allNodesCount.toLocaleString()} nodes — {limits.lowMemory
							? 'too much memory to show in full on this device'
							: 'too slow to render in full'}</span
					>
				{/if}
			</section>
			{/if}

			<!-- Hover mode: what pointing at a node does, over and above the tooltip.
			     Info (default) keeps hover cheap; Bubbles and Walks each build an index
			     over the graph, so they read as opt-in and warn on a large locus. -->
			<section class="group hover-group">
				<span class="group-title">Node inspector</span>
				<div class="seg" role="radiogroup" aria-label="Node inspector mode">
					<button
						class:active={hoverMode === 'none'}
						role="radio"
						aria-checked={hoverMode === 'none'}
						onclick={() => (hoverMode = 'none')}
						title="Don't open the inspector on click — click node to node to switch the MSA view without the box popping up.">None</button
					>
					<button
						class:active={hoverMode === 'info'}
						role="radio"
						aria-checked={hoverMode === 'info'}
						onclick={() => (hoverMode = 'info')}
						title="Just show the node tooltip; click a node to inspect it.">Info</button
					>
					<button
						class:active={hoverMode === 'bubble'}
						role="radio"
						aria-checked={hoverMode === 'bubble'}
						onclick={() => (hoverMode = 'bubble')}
						title="Light up every node of the bubble the hovered node belongs to, and show its shortest/longest path in the inspector."
						>Bubbles</button
					>
					<button
						class:active={hoverMode === 'walk'}
						role="radio"
						aria-checked={hoverMode === 'walk'}
						onclick={() => (hoverMode = 'walk')}
						title="Trace every walk that passes through the hovered node, each in its own colour (needs the full-walk graph)."
						>Walks</button
					>
				</div>
				{#if hoverMode === 'none'}
					<span class="switch-sub">no inspector on click · MSA still switches</span>
				{:else if hoverMode === 'info'}
					<span class="switch-sub">tooltip only · click to inspect</span>
				{:else if hoverMode === 'bubble'}
					<span class="switch-sub">hover a node to light up its whole bubble</span>
					{#if hoverModeHeavy}
						<span class="switch-sub note"
							>{adapted.keptSegments.toLocaleString()} nodes — cataloguing bubbles may take a moment.</span
						>
					{/if}
				{:else if hoverMode === 'walk'}
					{#if !hasTraversals}
						<span class="switch-sub note"
							>⚠︎ This graph has no walks or paths to trace — its only backbone is the computed
							one. Try <b>Bubbles</b> instead.</span
						>
					{:else if walkLoadBlocked}
						<span class="switch-sub note"
							>too much memory to load these walks on this device — open on a desktop</span
						>
					{:else if walkModeNeedsLoad}
						<span class="switch-sub"
							>{#if discoLoading || walkLoadRequested}loading the full-walk graph…{:else if discoAvailable}needs
								the full-walk graph{:else}no walk data available for this graph{/if}</span
						>
					{:else}
						<span class="switch-sub">hover a node to trace its walks</span>
					{/if}
					{#if hoverModeHeavy}
						<span class="switch-sub note"
							>{adapted.keptSegments.toLocaleString()} nodes — tracing every walk can be slow on a large
							locus.</span
						>
					{/if}
				{/if}
			</section>

			<!-- Haplotypes: the disco-walks spotlight and the per-walk list live in one
			     box. On the hosted locus browser the walks live only in the unsimplified
			     graph (loaded on demand), so before that's fetched this offers to load
			     them — the same fetch disco-walks uses. -->
			{#if showHaploBox}
				<section class="group haplo">
					<div class="haplo-head">
						<span class="switch-label">{panelHeader}</span>
						{#if namedWalks.length > 0}
							{#if nodeFilter}
								<span class="switch-sub"
									>{throughNodeWalks.length} of {namedWalks.length} through node <code>{nodeFilter}</code
									></span
								>
							{:else if straightenKey}
								<span class="switch-sub">one {panelNoun === 'paths' ? 'path' : 'walk'} straightened below the reference</span>
							{:else if pinnedKeys.length > 0}
								<span class="switch-sub">{pinnedKeys.length} traced · click more to compare</span>
							{:else}
								<span class="switch-sub"
									>{namedWalks.length} {panelNoun} · click to trace, 📐 to straighten</span
								>
							{/if}
						{/if}
					</div>

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
							<span class="switch-sub"
								>spotlighting each of {discoWalks.length.toLocaleString()} unique walks{straightenKey
									? ' through the straightened layout'
									: ''}</span
							>
						{/if}
					{/if}

					{#if namedWalks.length > 0}
						{#if nodeFilter}
							<button
								class="haplo-nodefilter"
								onclick={() => (nodeFilter = null)}
								title="Show all walks again"
							>
								<span>filtered to node <code>{nodeFilter}</code></span>
								<span class="hnf-x">clear ×</span>
							</button>
						{/if}
						{#if throughNodeWalks.length > 8}
							<input class="haplo-filter" placeholder="filter…" bind:value={haploFilter} />
						{/if}
						<ul class="haplo-list">
							{#each filteredNamedWalks as w (w.key)}
								{@const isPinned = pinnedKeys.includes(w.key)}
								{@const isStraight = straightenKey === w.key}
								<li class="haplo-row">
									<button
										class="haplo-item"
										class:active={isPinned}
										class:hovering={w.key === hoverKey && !isPinned}
										onclick={() => togglePin(w.key)}
										onmouseenter={() => (hoverKey = w.key)}
										onmouseleave={() => hoverKey === w.key && (hoverKey = null)}
										onfocus={() => (hoverKey = w.key)}
										onblur={() => hoverKey === w.key && (hoverKey = null)}
										title={`${w.sample} · hap ${w.hapIndex} · ${w.seqId}`}
									>
										{#if isPinned || isStraight || w.key === hoverKey}
											<span class="hl-dot" style="background:{colorForKey(w.key)}"></span>
										{/if}
										<span class="hl-name">{w.label}</span>
										{#if w.sample !== 'unknown' && !traversalsArePaths}<span class="hl-hap">hap {w.hapIndex}</span>{/if}
										<span class="hl-span">{w.span > 0 ? `${w.span.toLocaleString()} bp` : ''}</span>
									</button>
									<button
										class="haplo-straighten"
										class:active={isStraight}
										onclick={() => toggleStraighten(w.key)}
										title={isStraight
											? 'Stop straightening this walk'
											: 'Straighten this walk into a horizontal track below the reference'}
										aria-pressed={isStraight}
										aria-label="Straighten {w.label}">📐</button
									>
								</li>
							{/each}
							{#if filteredNamedWalks.length === 0}
								<li class="haplo-empty">
									{#if haploFilter.trim()}no walk matches “{haploFilter}”{:else}no walks through this
										node{/if}
								</li>
							{/if}
						</ul>
						{#if straightenKey}
							<button
								class="haplo-clear straighten-clear"
								onclick={() => (straightenKey = null)}
								title="Stop straightening and relax the layout back to normal"
								>📐 clear straightened {straightenLabel}</button
							>
						{/if}
						{#if pinnedKeys.length > 0}
							<button class="haplo-clear" onclick={() => (pinnedKeys = [])}
								>clear {pinnedKeys.length > 1 ? `all ${pinnedKeys.length} traces` : 'trace'}</button
							>
						{/if}
					{:else if walkLoadBlocked}
						<!-- Memory-constrained device, repetitive locus (LPA and the like):
						     parsing every walk would likely crash the tab, so don't offer it. -->
						<span class="switch-sub note"
							>{fullGraphWalks.toLocaleString()} haplotype walks — too much memory to load on this device
							without risking a crash. Open on a desktop to inspect them.</span
						>
					{:else if canLoadHaplos}
						{#if discoLoading || walkLoadRequested || haploDataLight}
							<!-- Light loci auto-load (an effect fires as soon as `haploDataLight`),
							     so this covers both the auto-load and an in-flight manual load. -->
							<span class="switch-sub">loading haplotypes…</span>
						{:else}
							<button
								class="haplo-load"
								onclick={() => {
									walkLoadRequested = true;
									onRequestDiscoGraph?.();
								}}
								title="Fetch the full-walk graph so individual walks can be traced and straightened"
								>Load haplotypes to inspect</button
							>
							<span class="switch-sub"
								>{fullGraphWalks.toLocaleString()} haplotype walks — loaded on request</span
							>
						{/if}
					{/if}
				</section>
			{/if}

			<!-- Secondary controls, grouped into tabs so the panel doesn't grow forever. -->
			<nav class="ctl-tabs">
				<button class:active={ctlTab === 'layout'} onclick={() => (ctlTab = 'layout')}>Layout</button>
				<button class:active={ctlTab === 'view'} onclick={() => (ctlTab = 'view')}>View</button>
			</nav>
			<section class="group ctl-panel">
				{#if ctlTab === 'layout'}
						<div class="mode-picker">
							<div class="family-toggle" role="group" aria-label="Layout family">
								<button
									type="button"
									class:active={modeCfg.family === 'anchored'}
									onclick={() => selectFamily('anchored')}
									title="Lay the graph out along the reference — a coordinate axis with variant bubbles hanging off it."
								>
									Reference-based
								</button>
								<button
									type="button"
									class:active={modeCfg.family === 'free'}
									onclick={() => selectFamily('free')}
									title="Ignore the reference and let the graph settle into its own shape. No coordinates or gene track."
								>
									Reference-free
								</button>
							</div>
							<select class="mode-select" bind:value={layoutMode} aria-label="Layout mode">
								{#each LAYOUT_MODES.filter((m) => m.family === modeCfg.family) as m (m.id)}
									<option value={m.id}>{m.label}</option>
								{/each}
							</select>
							<p class="mode-blurb">{modeCfg.blurb}</p>
							<!-- Backbone picker / note: only meaningful for a reference-anchored
							     layout, so it lives here (and only when the parent supplies choices —
							     the /gfa page). More than one option → a picker bound to the chosen
							     reference; otherwise the note explaining a computed/rGFA backbone. -->
							{#if modeCfg.family === 'anchored'}
								{#if backboneOptions.length > 1}
									<label class="backbone-pick">
										<span class="backbone-label">Backbone</span>
										<select bind:value={referenceSample} aria-label="Reference backbone">
											{#each backboneOptions as s (s)}
												<option value={s}>{s}</option>
											{/each}
										</select>
									</label>
								{:else if backboneNote}
									<p class="backbone-note">{backboneNote}</p>
								{/if}
							{/if}
						</div>
						<!-- Bendy nodes: the single biggest speed lever, phrased as the pretty
						     option so it reads as a choice, not a downgrade. On means the
						     full-detail force layout (each segment relaxes into a curve) — pretty
						     but ~5 ms/node, seconds on a large graph. Off is the rough layout
						     (one straight node per segment), an order of magnitude faster. It
						     turns off automatically past limits.roughLayoutNodes; this switch
						     forces it either way for the current graph. -->
						<label
							class="switch"
							title="Draw each segment as a relaxed curve (full detail). Prettier but much slower on large graphs, so it turns off automatically on big ones — toggle to override for this graph."
						>
							<input
								type="checkbox"
								checked={effectiveBendy}
								onchange={(e) => (bendyOverride = e.currentTarget.checked)}
							/>
							<span class="track"><span class="thumb"></span></span>
							<span class="switch-text">
								<span class="switch-label">Bendy nodes</span>
								<span class="switch-sub">Pretty but slower</span>
							</span>
						</label>
					{:else if ctlTab === 'view'}
						{#if !referenceFree}
							<label class="switch" title="Draw the gene track (exons, strand, UTRs) below the reference axis.">
								<input type="checkbox" bind:checked={showGeneTrack} />
								<span class="track"><span class="thumb"></span></span>
								<span class="switch-text">
									<span class="switch-label">Gene track</span>
									<span class="switch-sub">annotated transcripts under the graph</span>
								</span>
							</label>
						{/if}
						<label class="switch" title="Render on a white background for figures and publication screenshots">
							<input type="checkbox" bind:checked={lightMode} />
							<span class="track"><span class="thumb"></span></span>
							<span class="switch-text">
								<span class="switch-label">Light mode</span>
								<span class="switch-sub">white background for figures</span>
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
						<button class="action" onclick={exportImage} title="Download the current view as a high-resolution PNG">
							⬇ Export PNG
						</button>
					{/if}
			</section>
			</div>
		</aside>

	<div class="stage-col">
			<div class="stage" class:msa-open={msaOpen}>
				{#if displayLayout}
					<GraphCanvas
						layout={displayLayout}
						refCoords={referenceFree ? undefined : refCoords}
						genes={referenceFree ? [] : genes}
						showGenes={showGeneTrack && !referenceFree}
						discoPaths={overlayPaths}
						highlightSegments={bubbleHighlight}
						onHoverSegment={(id) => (hoveredNode = id)}
						{skipBubbles}
						{activeSkipKey}
						onHoverSkip={(k) => (hoveredSkip = k)}
						{exitHighlightSegments}
						onExitSegments={(ids) => (exitSegIds = new Set(ids))}
						{lightMode}
						{nodeTooltip}
						{showExits}
						{colorMode}
						{bubbleIdBySeg}
						{bubbleLongestBySeg}
						{maxBubbleLongest}
						nodeLabels={msaNames}
						{flashSegment}
						{flashNonce}
						discoActive={traceActive}
						onReady={(api) => (canvasApi = api)}
						onSelectSegment={(id) => {
							selected = id;
							if (id) {
								inspectorDismissed = false;
								trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_node' });
							}
						}}
						onSelectFeature={(f) => {
							selectedFeature = f;
							if (f) {
								inspectorDismissed = false;
								trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_gene' });
							}
						}}
						onSelectSkip={(s) => {
							selectedSkip = s;
							if (s) {
								inspectorDismissed = false;
								trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_skip' });
							}
						}}
						onSelectExit={(e) => {
							selectedExit = e;
							if (e) {
								inspectorDismissed = false;
								trackEvent('widget_interact', { widget: 'graph_layout', action: 'select_exit' });
							}
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
									{adapted.keptSegments.toLocaleString()} nodes is a lot — this can take up to a minute
									on a large or repetitive locus. Still working, not stuck.
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
							{adapted.keptSegments.toLocaleString()} nodes — the graph can take up to a minute on a
							large or repetitive locus. The variant&nbsp;arcs and gene track below are ready now.
						</div>
					{/if}
				{:else if computing}
					<div class="busy-badge">
						<span class="spinner"></span> computing layout…
					</div>
				{/if}

				<!-- Hover-mode readout: a small badge naming what's lit up under the pointer
				     (or frozen by a click). Bubble mode names the bubble's path extremes;
				     walk mode names how many walks run through the node (the count is exact
				     even when the drawn overlays are capped). -->
				{#if hoverMode === 'bubble' && bubbleHighlight}
					{@const nb = activeNode ? nodeToBubble.get(activeNode) : null}
					{#if nb}
						<div class="trace-badge">
							<span class="tb-dot" style="background:#22d3ee"></span>
							bubble · <b
								>{nb.shortest === nb.longest
									? `${nb.longest.toLocaleString()} bp`
									: `${nb.shortest.toLocaleString()}–${nb.longest.toLocaleString()} bp`}</b
							>
							path · {nb.nodeCount.toLocaleString()} nodes
						</div>
					{/if}
				{:else if hoverMode === 'walk' && activeWalkCount > 0}
					<div class="trace-badge">
						tracing <b>{activeWalkCount.toLocaleString()}</b> walk{activeWalkCount === 1 ? '' : 's'}
						{walkTarget?.type === 'skip' ? 'taking this deletion' : 'through this node'}{#if activeWalkCount > MAX_WALK_HOVER_PATHS}
							<span class="tb-more">· showing {MAX_WALK_HOVER_PATHS}</span>{/if}
					</div>
				{/if}

				<!-- On-graph legend of the traced haplotypes. A hover preview (single)
				     supersedes the pinned comparison set. -->
				{#if hoverWalk}
					<div class="trace-badge">
						<span class="tb-dot" style="background:{colorForKey(hoverWalk.key)}"></span>
						preview <b>{hoverWalk.sample} · hap {hoverWalk.hapIndex}</b>
					</div>
				{:else if pinnedWalks.length > 0}
					<div class="trace-legend">
						{#each pinnedWalks as w (w.key)}
							<div class="tl-row">
								<span class="tb-dot" style="background:{colorForKey(w.key)}"></span>
								<span class="tl-name">{w.sample} · hap {w.hapIndex}</span>
								<button class="tb-close" onclick={() => togglePin(w.key)} aria-label="Remove from comparison"
									>×</button
								>
							</div>
						{/each}
						{#if pinnedWalks.length > 1}
							<button class="tl-clear" onclick={() => (pinnedKeys = [])}>clear all</button>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Base-alignment (MSA) split: a resizable panel below the graph, driven by
			     the selected node. A drag handle on top resizes it; the graph (flex:1)
			     shrinks to make room. -->
			{#if msaOpen}
				<div class="msa-split" style="height:{msaHeight}px">
					<div
						class="msa-resize"
						onpointerdown={startMsaResize}
						role="separator"
						aria-label="Resize the alignment panel"
						title="Drag to resize"
					></div>
					<div class="msa-split-inner">
						<MsaPanel
							{gfa}
							{referenceSample}
							selectedSegId={selected}
							{lightMode}
							colorForSeg={msaColorForSeg}
							{colorMode}
							rowHighlights={msaRowHighlights}
							loadingFullGraph={discoLoading && !showingAllNodes}
							fullGraphBlocked={!!gfa.reduced && !discoAvailable}
							onClose={() => (msaOpen = false)}
							onNames={(m) => (msaNames = m)}
							onNodeFlash={flashGraphNode}
							onWalkSpotlight={toggleMsaWalk}
						/>
					</div>
				</div>
			{/if}

				<!-- Node inspector: lives OUTSIDE .stage (which clips with overflow:hidden)
				     so on mobile it can drop below the graph instead of overlapping it. On
				     desktop it still floats over the graph's top-left corner — absolute,
				     anchored to .stage-col. The × only hides the box (keeping the frozen
				     highlight lit); clicking the empty graph clears the selection. -->
				{#if selected && !inspectorDismissed && hoverMode !== 'none'}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">
								{#if showNodeId}Node <code>{selected}</code>{:else}Node{/if}
							</span>
							<div class="insp-actions">
								<button
									class="insp-gear"
									class:active={nodeFieldsOpen}
									onclick={() => (nodeFieldsOpen = !nodeFieldsOpen)}
									aria-label="Node fields"
									aria-expanded={nodeFieldsOpen}
									title="Choose which fields to show about a node"
								>
									⚙
								</button>
								<button class="insp-close" onclick={() => (inspectorDismissed = true)} aria-label="Close">×</button>
							</div>
						</div>

						{#if nodeFieldsOpen}
							<!-- The old "Nodes" tab, now a per-inspector settings popover: picks which
							     fields appear here and in the hover tooltip. -->
							<div class="ni-settings">
								<span class="ni-settings-title">Show fields</span>
								<label class="check"><input type="checkbox" bind:checked={showNodeId} /> Node ID</label>
								<label class="check"><input type="checkbox" bind:checked={showLength} /> Length (bp)</label>
								<label class="check" class:disabled={referenceFree}>
									<input type="checkbox" bind:checked={showCoords} disabled={referenceFree} /> Coordinates
								</label>
								<label class="check"><input type="checkbox" bind:checked={showSequence} /> Sequence</label>
								{#if referenceFree}
									<span class="ni-settings-note">Coordinates need a reference-based layout.</span>
								{/if}
							</div>
						{/if}

						{#if showLength || (showCoords && !referenceFree)}
							<div class="ni-fields">
								{#if showLength}
									<span class="ni-field"
										><span class="ni-key">length</span> {selectedLen?.toLocaleString() ?? '—'} bp</span
									>
								{/if}
								{#if showCoords && !referenceFree}
									<span class="ni-field"
										><span class="ni-key">coords</span>
										{#if selectedCoord}<span class="coord">{fmtCoord(selectedCoord)}</span>{:else}<span
												class="muted">—</span
											>{/if}</span
									>
								{/if}
							</div>
						{/if}

						{#if !msaOpen}
							<button
								class="ni-msa-btn"
								onclick={() => {
									// The MSA needs the full graph's per-haplotype walks. On a simplified
									// (reduced) graph, switch to the full graph automatically — but only when
									// this device can show it (`discoAvailable`). On a low-memory/phone tab where
									// the full graph is too heavy, we don't force the load; the panel opens and
									// explains why it can't align here.
									if (gfa.reduced && !showingAllNodes && discoAvailable && onToggleSimplify) {
										// Stash the full-graph node to align on (an original member of the clicked
										// reduced node); the reset effect re-opens the MSA on it once the full
										// graph arrives, since the swap would otherwise drop the selection.
										const members = selected ? gfa.segments.get(selected)?.members : undefined;
										pendingMsaNode =
											members && members.length ? members[Math.floor(members.length / 2)] : selected;
										onToggleSimplify();
									} else {
										msaOpen = true;
									}
									trackEvent('widget_interact', { widget: 'graph_layout', action: 'open_msa' });
								}}
								title="Load the full graph and align this node's sequences"
							>
								≡ Load MSA
							</button>
						{/if}

						{#if hoverMode === 'bubble'}
							<div class="ni-bubble">
								{#if selectedBubble}
									<span class="ni-bubble-title">This node's bubble</span>
									<div class="ni-fields">
										<span class="ni-field"
											><span class="ni-key">shortest path</span>
											{selectedBubble.shortest.toLocaleString()} bp</span
										>
										<span class="ni-field"
											><span class="ni-key">longest path</span>
											{selectedBubble.longest.toLocaleString()} bp</span
										>
										<span class="ni-field"
											><span class="ni-key">reference span</span>
											{selectedBubble.refSpan.toLocaleString()} bp</span
										>
										<span class="ni-field"
											><span class="ni-key">segments</span>
											{selectedBubble.nodeCount.toLocaleString()}</span
										>
										<span class="ni-field"
											><span class="ni-key">walks</span>
											{selectedBubble.coverage.toLocaleString()}</span
										>
									</div>
									{#if selectedBubbleExits}
										<span class="ni-exit-note">↳ leaves the locus — a strand of this bubble is
											chopped at the window edge (highlighted dashed).</span
										>
										{#if onRequestMoreContext && !hasEndpointSection}
											<button class="exit-more" onclick={() => onRequestMoreContext?.()}>
												Increase context &amp; re-query
											</button>
										{/if}
									{/if}
								{:else}
									<span class="ni-haplo-hint muted">this node is on the reference backbone (not a bubble)</span>
								{/if}
							</div>
						{:else if hoverMode === 'walk'}
							<div class="ni-bubble">
								{#if walkModeNeedsLoad}
									<span class="ni-haplo-hint muted"
										>{#if discoLoading || walkLoadRequested}loading the full-walk graph…{:else}walk data
											isn't available for this graph{/if}</span
									>
								{:else if selectedWalkCount > 0}
									<span class="ni-field"
										><span class="ni-key">walks through here</span>
										{selectedWalkCount.toLocaleString()}</span
									>
									<span class="ni-haplo-hint">hover the node to trace them on the graph</span>
									{#if selectedWalkExits}
										<span class="ni-exit-note">↳ leaves the locus — a walk through this node is
											chopped at the window edge (highlighted dashed).</span
										>
										{#if onRequestMoreContext && !hasEndpointSection}
											<button class="exit-more" onclick={() => onRequestMoreContext?.()}>
												Increase context &amp; re-query
											</button>
										{/if}
									{/if}
								{:else}
									<span class="ni-haplo-hint muted">no walk passes through this node</span>
								{/if}
							</div>
						{/if}

						{#if showHaplotypes && namedWalks.length > 0}
							<div class="ni-haplo">
								{#if selectedThroughCount > 0}
									<button
										class="ni-haplo-btn"
										class:active={nodeFilter === selected}
										onclick={() => (nodeFilter = nodeFilter === selected ? null : selected)}
									>
										{#if nodeFilter === selected}
											✓ showing {selectedThroughCount} haplotype{selectedThroughCount === 1 ? '' : 's'} through
											this node
										{:else}
											Filter haplotypes to the {selectedThroughCount} through this node
										{/if}
									</button>
									<span class="ni-haplo-hint"
										>disco-walks will then cycle only these {selectedThroughCount} walk{selectedThroughCount ===
										1
											? ''
											: 's'}</span
									>
								{:else}
									<span class="ni-haplo-hint muted">no named haplotype passes through this node</span>
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

						{#if endpointCounts || endpoints.length > 0}
							<div class="endpoints">
								<p class="exit-note">
									A haplotype leaves the queried window here and continues into the graph
									<b>beyond the region that was fetched</b>. We can't show where it reconnects — that node
									is outside this subgraph (exit point shown as dashed line). Note that reference nodes outside this locus that
									are pulled in by their connections to this locus are unfortunately not marked as reference
									(a limitation of querying because they don't appear in the reference walk).
								</p>
								{#if endpointCounts}
									{@const total = endpointCounts.starts + endpointCounts.ends}
									<span class="etag"
										>{total.toLocaleString()} walk{total === 1 ? ' starts/ends' : 's start/end'} here</span
									>
								{:else}
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
								{/if}
								{#if onRequestMoreContext}
									<button class="exit-more" onclick={() => onRequestMoreContext?.()}>
										Increase context &amp; re-query
									</button>
									<span class="exit-hint">
										Widens the window past the locus so the query follows these haplotypes further —
										fewer dangling exits, more nodes shown.
									</span>
								{/if}
							</div>
						{/if}
					</div>
				{:else if selectedFeature && !inspectorDismissed}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">Gene <code>{selectedFeature.symbol}</code></span>
							<button class="insp-close" onclick={() => (inspectorDismissed = true)} aria-label="Close"
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
				{:else if selectedSkip && !inspectorDismissed}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">Deletion (skip)</span>
							<button class="insp-close" onclick={() => (inspectorDismissed = true)} aria-label="Close"
								>×</button
							>
						</div>
						<p class="insp-explain">
							A skip bubble jumps straight over the reference with no alternate node — the
							alternate path takes <b>0 bp</b>, so it's shown by the reference it deletes.
						</p>
						<div class="ni-fields">
							<span class="ni-field"
								><span class="ni-key">alternate path</span> 0 bp</span
							>
							<span class="ni-field"
								><span class="ni-key">reference deleted</span> {selectedSkip.refSpan.toLocaleString()} bp</span
							>
							{#if hoverMode !== 'walk'}
								<span class="ni-field"
									><span class="ni-key">walks</span> {selectedSkip.coverage.toLocaleString()}</span
								>
							{/if}
							<span class="ni-field"
								><span class="ni-key">coords</span>
								<span class="coord"
									>{selectedSkip.contig}:{selectedSkip.gStart.toLocaleString()}{selectedSkip.gStart !==
									selectedSkip.gEnd
										? '–' + selectedSkip.gEnd.toLocaleString()
										: ''}</span
								></span
							>
						</div>
						{#if hoverMode === 'walk'}
							<div class="ni-bubble">
								{#if selectedSkipWalkCount > 0}
									<span class="ni-field"
										><span class="ni-key">walks taking it</span>
										{selectedSkipWalkCount.toLocaleString()}</span
									>
									<span class="ni-haplo-hint">hover the arc to trace them on the graph</span>
								{:else}
									<span class="ni-haplo-hint muted">no walk takes this deletion</span>
								{/if}
							</div>
						{/if}
					</div>
				{:else if selectedExit && !inspectorDismissed}
					<div class="inspector">
						<div class="insp-head">
							<span class="insp-title">Off-locus exit</span>
							<button class="insp-close" onclick={() => (inspectorDismissed = true)} aria-label="Close"
								>×</button
							>
						</div>
						<p class="exit-note">
							A haplotype leaves the queried window here and continues into the graph
							<b>beyond the region that was fetched</b>. We can't show where it reconnects — that node
							is outside this subgraph (exit point shown as dashed line). Note that reference nodes outside this locus that
							are pulled in by their connections to this locus are unfortunately not marked as reference
							(a limitation of querying because they don't appear in the reference walk).
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
		<div class="foot">
			<span class="muted">plain scroll pans · ⌘/ctrl-scroll (or pinch) zooms</span>
			<span class="spacer"></span>
			<span class="legend"><span class="sw backbone"></span> reference backbone</span>
			<label class="legend legend-color" title="What each node's fill encodes">
				<span class="legend-by">color by</span>
				<select
					class="color-select"
					bind:value={colorMode}
					onchange={() =>
						trackEvent('widget_interact', { widget: 'graph_layout', action: 'color_mode' })}
				>
					{#each COLOR_MODES as m (m.mode)}
						<option value={m.mode}>{m.label}</option>
					{/each}
				</select>
				<span
					class="sw"
					class:grad={colorModeInfo.kind === 'heatmap'}
					class:bubbles={colorModeInfo.kind === 'discrete'}
					style={colorModeInfo.kind === 'heatmap'
						? `background:${legendGradientCss(colorMode, lightMode, legendTheme)}`
						: ''}
				></span>
				<span class="legend-cap">{colorModeInfo.caption}{colorModeInfo.kind === 'heatmap' ? ' →' : ''}</span>
			</label>
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
		/* Positioning context for the node inspector, which now lives here (a sibling
		   of .stage) so it can float over the graph on desktop but flow below it on
		   mobile. */
		position: relative;
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
	.group-title {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #9aa0aa;
	}
	.hover-group {
		background: #fff;
	}
	/* Segmented control (Info / Bubbles / Walks) for the hover mode. */
	.seg {
		display: flex;
		gap: 2px;
		background: #eef0f4;
		border: 1px solid #e6e8ec;
		border-radius: 8px;
		padding: 2px;
	}
	.seg button {
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
	.seg button:hover {
		color: #333;
	}
	.seg button.active {
		background: #fff;
		color: #0e7490;
		box-shadow: 0 1px 2px rgba(16, 24, 40, 0.1);
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
	/* A disabled switch (a reference-anchored knob while a free mode is active). */
	.switch:has(input:disabled) {
		cursor: default;
		opacity: 0.45;
	}

	/* Layout-mode picker — the primary layout control. */
	.mode-picker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	/* Segmented control that splits the two layout families apart. */
	.family-toggle {
		display: flex;
		gap: 2px;
		padding: 2px;
		background: #eef0f3;
		border-radius: 8px;
	}
	.family-toggle button {
		flex: 1;
		font: inherit;
		font-size: 0.72rem;
		font-weight: 600;
		padding: 0.35rem 0.3rem;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: #6b7280;
		cursor: pointer;
	}
	.family-toggle button.active {
		background: #fff;
		color: #1a1a1a;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}
	.family-toggle button:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}
	.mode-select {
		font: inherit;
		padding: 0.4rem 0.5rem;
		border: 1px solid #cbd0d8;
		border-radius: 7px;
		background: #fff;
		color: #222;
		cursor: pointer;
	}
	.mode-select:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}
	.mode-blurb {
		margin: 0;
		font-size: 0.74rem;
		line-height: 1.35;
		color: #6b7280;
	}
	/* Backbone picker inside the reference-based layout options (the /gfa page). */
	.backbone-pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.5rem;
		font-size: 0.76rem;
		color: #6b7280;
	}
	.backbone-label {
		flex: 0 0 auto;
	}
	.backbone-pick select {
		flex: 1 1 auto;
		min-width: 0;
		font: inherit;
		font-size: 0.78rem;
		padding: 0.3rem 0.4rem;
		border: 1px solid #cbd0d8;
		border-radius: 6px;
		background: #fff;
		color: #222;
		cursor: pointer;
	}
	.backbone-note {
		margin: 0.5rem 0 0;
		font-size: 0.74rem;
		line-height: 1.35;
		color: #5b6472;
		background: #f4f6fa;
		border: 1px solid #e3e7ee;
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
	}

	/* Node-inspector header actions (gear + close) and the gear settings popover. */
	.insp-actions {
		display: flex;
		align-items: center;
		gap: 0.15rem;
	}
	/* Gear + close share one square, flex-centred box so the two glyphs line up
	   despite their different sizes and metrics. */
	.insp-gear,
	.insp-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		line-height: 1;
		border-radius: 5px;
	}
	.insp-gear {
		border: none;
		background: transparent;
		color: #9aa0aa;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.insp-gear:hover,
	.insp-gear.active {
		color: #e5e7eb;
		background: rgba(255, 255, 255, 0.08);
	}
	.ni-settings {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0.1rem 0 0.5rem;
		padding: 0.5rem;
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.05);
	}
	.ni-settings-title {
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #9aa0aa;
	}
	.ni-settings .check {
		color: #d7dae0;
		font-size: 0.8rem;
	}
	.ni-settings .check.disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ni-settings-note {
		font-size: 0.68rem;
		line-height: 1.3;
		color: #8b909a;
	}

	/* Named-haplotype panel (the /gfa page). */
	.haplo {
		gap: 0.4rem;
	}
	.haplo-head {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
	}
	.haplo-filter {
		font: inherit;
		font-size: 0.78rem;
		padding: 0.25rem 0.4rem;
		border: 1px solid #d3d6dd;
		border-radius: 6px;
		background: #fff;
		color: #333;
	}
	.haplo-filter:focus {
		outline: 2px solid #2563eb;
		outline-offset: -1px;
		border-color: #2563eb;
	}
	.haplo-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 260px;
		overflow-y: auto;
	}
	.haplo-row {
		display: flex;
		align-items: stretch;
		gap: 2px;
	}
	.haplo-item {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		flex: 1 1 auto;
		min-width: 0;
		font: inherit;
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
		background: #fff;
		border: 1px solid #eee;
		border-radius: 6px;
		padding: 0.25rem 0.45rem;
		color: #333;
	}
	.haplo-item:hover {
		border-color: #c7b8ec;
		background: #faf7ff;
	}
	.haplo-item.active {
		border-color: #7c3aed;
		background: #f3ecff;
		box-shadow: inset 0 0 0 1px rgba(124, 58, 237, 0.35);
	}
	.haplo-item.hovering {
		border-color: #c7b8ec;
		background: #faf7ff;
	}
	.haplo-straighten {
		flex: 0 0 auto;
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
		border: 1px solid #eee;
		background: #fff;
		border-radius: 6px;
		padding: 0 0.35rem;
		filter: grayscale(1);
		opacity: 0.55;
	}
	.haplo-straighten:hover {
		border-color: #c7b8ec;
		background: #faf7ff;
		filter: none;
		opacity: 1;
	}
	.haplo-straighten.active {
		border-color: #7c3aed;
		background: #f3ecff;
		box-shadow: inset 0 0 0 1px rgba(124, 58, 237, 0.35);
		filter: none;
		opacity: 1;
	}
	/* Live slow-layout tip: an actionable amber card above the controls. */
	.slow-tip {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		background: #fdf1dd;
		border: 1px solid #f0d9a8;
		border-radius: 9px;
		padding: 0.6rem 0.7rem;
		margin-bottom: 0.7rem;
	}
	.slow-tip-text {
		font-size: 0.78rem;
		line-height: 1.4;
		color: #7a4f07;
	}
	.slow-tip-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.slow-tip-cta {
		font: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid #e0b667;
		background: #fff;
		color: #92600b;
		padding: 0.3rem 0.55rem;
		border-radius: 6px;
	}
	.slow-tip-cta:hover {
		background: #fff8ec;
	}
	.slow-tip-dismiss {
		font: inherit;
		font-size: 0.74rem;
		cursor: pointer;
		border: none;
		background: none;
		color: #b07d2a;
		padding: 0.3rem 0.3rem;
		text-decoration: underline;
	}
	.slow-tip-dismiss:hover {
		color: #7a4f07;
	}

	.haplo-load {
		font: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid #d1c4f0;
		background: #f6f2ff;
		color: #5b21b6;
		padding: 0.35rem 0.5rem;
		border-radius: 7px;
		text-align: left;
	}
	.haplo-load:hover {
		background: #efe7ff;
		border-color: #c7b8ec;
	}
	.hl-dot {
		flex: 0 0 auto;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		align-self: center;
	}
	.hl-name {
		font-weight: 600;
		color: #1f2430;
		/* Long path names (e.g. rGFA/odgi "gi|568815592:32578768-32589835") must
		   truncate rather than shove the hap/span columns out of the box; the full
		   name stays in the row's title tooltip. */
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hl-hap {
		flex: 0 0 auto;
		color: #9aa0aa;
		font-size: 0.7rem;
	}
	.hl-span {
		flex: 0 0 auto;
		margin-left: auto;
		color: #9aa0aa;
		font-size: 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
	}
	.haplo-empty {
		list-style: none;
		font-size: 0.74rem;
		color: #9aa0aa;
		padding: 0.3rem 0.2rem;
	}
	.haplo-clear {
		font: inherit;
		font-size: 0.76rem;
		cursor: pointer;
		border: 1px solid #d3d6dd;
		background: #fff;
		color: #5b21b6;
		padding: 0.25rem 0.5rem;
		border-radius: 6px;
	}
	.haplo-clear:hover {
		background: #f6f2ff;
		border-color: #c7b8ec;
	}
	/* Straighten clear — tinted to match the active 📐 toggle so it's clearly its
	   companion (the list can be long, so this is how you undo without hunting). */
	.straighten-clear {
		border-color: #c7b8ec;
		background: #f3ecff;
		font-weight: 600;
	}
	.straighten-clear:hover {
		background: #e9dcff;
		border-color: #7c3aed;
	}
	/* Active node-filter chip at the top of the haplotype panel. */
	.haplo-nodefilter {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		width: 100%;
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
		border: 1px solid #bfdbfe;
		background: #eff6ff;
		color: #1d4ed8;
		padding: 0.25rem 0.45rem;
		border-radius: 6px;
		text-align: left;
	}
	.haplo-nodefilter:hover {
		background: #dbeafe;
	}
	.haplo-nodefilter code {
		background: rgba(37, 99, 235, 0.12);
		padding: 0 3px;
		border-radius: 3px;
	}
	.hnf-x {
		flex: 0 0 auto;
		font-weight: 600;
		white-space: nowrap;
	}
	/* Node-inspector "filter haplotypes through this node" control. */
	.ni-haplo {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ni-haplo-btn {
		font: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid #d1c4f0;
		background: #f6f2ff;
		color: #5b21b6;
		padding: 0.35rem 0.5rem;
		border-radius: 7px;
		text-align: left;
		line-height: 1.3;
	}
	.ni-haplo-btn:hover {
		background: #efe7ff;
		border-color: #c7b8ec;
	}
	.ni-haplo-btn.active {
		border-color: #7c3aed;
		background: linear-gradient(90deg, #7c3aed, #db2777);
		color: #fff;
	}
	.ni-haplo-hint {
		font-size: 0.7rem;
		line-height: 1.35;
		color: #9aa0aa;
	}
	/* Bubble/walk block in the node inspector. */
	.ni-bubble {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding-top: 0.35rem;
		border-top: 1px solid #eceef2;
	}
	.ni-bubble-title {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #0e7490;
	}
	.tb-more {
		opacity: 0.7;
	}
	.ni-exit-note {
		font-size: 0.7rem;
		line-height: 1.35;
		color: #0e7490;
	}
	/* Floating "tracing X" badge over the graph while a haplotype is pinned. */
	.trace-badge {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 6;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.5rem 0.25rem 0.6rem;
		border-radius: 999px;
		background: rgba(11, 13, 18, 0.82);
		border: 1px solid rgba(154, 163, 178, 0.35);
		color: #e6e9ef;
		font-size: 0.76rem;
	}
	.trace-badge b {
		font-weight: 600;
		color: #fff;
	}
	/* Legend of the pinned comparison set, top-right over the graph. */
	.trace-legend {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		max-width: 260px;
		max-height: calc(100% - 20px);
		overflow-y: auto;
		padding: 0.35rem 0.5rem;
		border-radius: 10px;
		background: rgba(11, 13, 18, 0.82);
		border: 1px solid rgba(154, 163, 178, 0.35);
		color: #e6e9ef;
		font-size: 0.75rem;
	}
	.tl-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.tl-name {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tl-clear {
		align-self: flex-end;
		margin-top: 0.15rem;
		background: none;
		border: none;
		color: #cbd3e0;
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}
	.tl-clear:hover {
		color: #fff;
	}
	.tb-dot {
		flex: 0 0 auto;
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
	.tb-close {
		background: none;
		border: none;
		color: #cbd3e0;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.1rem;
	}
	.tb-close:hover {
		color: #fff;
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
	/* When the MSA panel is open below it, the graph must be free to shrink so the
	   two together don't overflow the column (which would flicker a scrollbar and
	   thrash both canvases' resize observers). */
	.stage.msa-open {
		min-height: 140px;
	}

	/* Base-alignment split panel below the graph. Fixed (drag-resizable) height, so
	   the graph above it (flex:1) yields the remaining space. */
	.msa-split {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid #eee;
		border-radius: 8px;
		overflow: hidden;
	}
	.msa-resize {
		height: 8px;
		flex: 0 0 auto;
		cursor: ns-resize;
		background: repeating-linear-gradient(
			90deg,
			transparent 0 6px,
			rgba(140, 155, 180, 0.5) 6px 10px
		);
		background-position: center;
		background-size: 32px 2px;
		background-repeat: no-repeat;
		background-color: rgba(140, 155, 180, 0.12);
	}
	.msa-resize:hover {
		background-color: rgba(140, 155, 180, 0.28);
	}
	.msa-split-inner {
		flex: 1 1 auto;
		min-height: 0;
	}
	.ni-msa-btn {
		display: block;
		width: 100%;
		margin: 0.5rem 0 0.1rem;
		padding: 0.4rem 0.6rem;
		font: inherit;
		font-size: 0.82rem;
		font-weight: 600;
		text-align: center;
		border: 1px solid rgba(103, 232, 249, 0.5);
		border-radius: 7px;
		background: rgba(103, 232, 249, 0.12);
		color: #0e7490;
		cursor: pointer;
	}
	.ni-msa-btn:hover {
		background: rgba(103, 232, 249, 0.22);
	}

	/* Stack the sidebar above the canvas on narrow screens. */
	@media (max-width: 640px) {
		.body {
			flex-direction: column;
		}
		.sidebar {
			flex-basis: auto;
		}
		/* More graph on a phone: the inspector no longer overlaps it (it flows below),
		   so give the canvas a taller frame. */
		.stage {
			min-height: 60vh;
		}
		/* The .inspector override lives after its base rule (search "position: static")
		   so it isn't undone by source order. */
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
	/* Discrete-bubble swatch: a few well-separated golden-angle hues. */
	.sw.bubbles {
		width: 60px;
		background: linear-gradient(
			90deg,
			hsl(0, 68%, 55%) 0 25%,
			hsl(137.5, 68%, 55%) 25% 50%,
			hsl(275, 68%, 55%) 50% 75%,
			hsl(52.5, 68%, 55%) 75% 100%
		);
	}
	/* Color-by picker, folded into the on-graph legend at the foot of the canvas. */
	.legend-color {
		gap: 5px;
	}
	.legend-by {
		color: #888;
	}
	.color-select {
		font: inherit;
		font-size: 0.78em;
		color: #333;
		background: #fff;
		border: 1px solid #d7dae0;
		border-radius: 6px;
		padding: 1px 4px;
		cursor: pointer;
	}
	.color-select:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}
	.legend-cap {
		color: #666;
		white-space: nowrap;
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
		/* Above the passive hover/trace readouts (z-index 6): on a narrow screen the
		   inspector spans nearly the full width, so a top-right trace badge would
		   otherwise land on top of the × and steal the tap. The interactive panel
		   always wins over a passive badge. */
		z-index: 7;
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
	/* Phone: drop the inspector below the graph instead of floating over it — on a
	   small screen the overlay covers most of the canvas. As a normal-flow child of
	   .stage-col it sits right under the graph, full width, and grows to fit. This
	   block must follow the base .inspector rule above so source order doesn't undo
	   `position: static`. */
	@media (max-width: 640px) {
		.inspector {
			position: static;
			width: auto;
			max-width: 100%;
			max-height: none;
		}
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
		color: #98a0ac;
		cursor: pointer;
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
	.endpoints .exit-note {
		font-size: 0.78rem;
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
