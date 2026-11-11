import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX } from 'd3-force';
import type { GfaGraph } from './types';
import { buildAdjacency, computeBackbones, type Backbone } from './backbone';
import { bubbleStringSpots } from './bubbleShape';
import { stableUnit } from './prng';
import { getModeConfig, type LayoutMode, type RefFreeParams } from './layoutModes';
import { runFm3, type Fm3Edge } from './fm3';
import { placeBubbleLanes } from './laneLayout';
import { buildAssemblyLayout, type AssemblyOptions } from './assemblyLayout';

/**
 * Builds a force-directed layout for a GFA graph and returns node positions
 * (see LayoutResult / buildAndRunLayout). Two things are common to every layout
 * this file produces:
 *
 *  - Each segment becomes a *chain* of sub-nodes whose total length is
 *    proportional to the segment's sequence length. At full ("bendy") detail
 *    the chain has many sub-nodes, so a segment can bow into a curved strand; at
 *    lower detail it collapses toward a single straight edge (fewer nodes = a
 *    much faster simulation). Structural links join the chains, optionally
 *    routed through an invisible "bend" node so a connector curves clear of what
 *    it would otherwise cut straight across.
 *
 *  - The result is deterministic: seed positions come from a stable per-id PRNG
 *    (see prng.ts), so the same graph always settles into the same drawing
 *    instead of a force sim's usual rotation/reflection/local-minimum ambiguity.
 *
 * Where the nodes actually go is chosen by the layout *mode* (see
 * layoutModes.ts), in two families:
 *
 *  - Anchored modes pin one "backbone" path per connected component (see
 *    backbone.ts) to a straight horizontal axis via d3-force's fixed nodes
 *    (fx/fy) — a genome-browser-style coordinate line — and seed everything else
 *    near its backbone attachment, relaxing only locally. The anchored
 *    Skyline mode ('classic', with `lanes` on) skips the simulation and places every
 *    bubble directly in horizontal lanes above the axis (see laneLayout.ts).
 *
 *  - Free modes ignore the backbone and let the simulation find the graph's own
 *    shape from a mode-specific seed (multilevel FM³, layered/DAG, radial,
 *    scatter; see fm3.ts and the seed* functions below).
 */

export interface SimNode {
	id: string;
	segId: string;
	posIndex: number;
	isChainEnd: boolean;
	x: number;
	y: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
	/** The y of this node's component's backbone line, used to keep bubbles from overlapping it. */
	componentBaselineY: number;
	/** Where this node sits on its bubble's loop of string (see bubbleShape.ts).
	 * Bubbles are pulled back toward these so each strand keeps that smooth shape
	 * instead of crumpling. Undefined for backbone nodes (which are pinned). */
	anchorX?: number;
	targetY?: number;
	/** The x range of its bubble's room on the reference (see bubbleShape.ts),
	 * which anchored layouts hold it inside. */
	room?: [number, number];
	/** Free-layout 'flow' mode only: the x this node is pulled toward, derived from
	 * its graph distance from a component endpoint (see seedLayered). */
	targetX?: number;
}

interface SimLink {
	source: string | SimNode;
	target: string | SimNode;
	distance: number;
	strength: number;
	kind: 'chain' | 'structural';
}

export interface SegmentChain {
	segId: string;
	nodeIds: string[];
}

export interface BackboneInfo {
	componentId: number;
	source: string;
	totalLength: number;
}

export interface LayoutResult {
	nodesById: Map<string, SimNode>;
	chains: SegmentChain[];
	/** `bendNode` is a zero-length, invisible simulation node inserted at the
	 * midpoint so the link can be drawn as a curve through it (see GraphCanvas) —
	 * without it, a link between two backbone-pinned points (e.g. a deletion
	 * skip edge) is a dead-straight line that lies exactly on top of the
	 * backbone and is invisible. */
	structuralLinkPaths: { from: string; to: string; fromNode: string; toNode: string; bendNode: string }[];
	backbones: BackboneInfo[];
	backboneSegIds: Set<string>;
	/** Reference-free modes only: the reference path's segments, so they can still
	 * be coloured as the reference even though nothing is laid out along it.
	 * (Kept apart from `backboneSegIds`, which also means "drawn on the axis".) */
	referenceSegIds?: Set<string>;
	segmentLengths: Map<string, number>;
	/** Count of non-reference (non-backbone) paths traversing each segment. */
	pathCoverage: Map<string, number>;
	maxPathCoverage: number;
	/** Assembly mode only (assemblyLayout.ts): extra geometry the canvas draws. */
	assembly?: {
		/** Backbone segment → [start, end] as a fraction of its reference, for colour. */
		refFrac: Map<string, [number, number]>;
		/** Deletions laid out through a hidden route node, drawn as dashed arcs. */
		routes: { from: string; to: string; fromNode: string; toNode: string; nodeIds: string[]; skipBp: number }[];
		/** Unbranched runs collapsed for the layout and split back afterwards. */
		runs: { members: string[]; bp: number }[];
	};
}

export interface LayoutOptions {
	/** Soft budget for how many sub-edges the reference backbone is divided into
	 * (this, not the whole graph's total sequence, sets the pixels-per-bp scale —
	 * see buildAndRunLayout). */
	targetTotalSubNodes?: number;
	/** Max sub-edges any single segment chain can be split into. */
	maxEdgesPerSegment?: number;
	unitEdgeLength?: number;
	iterations?: number;
	/** Route each structural link through an invisible bend node so it curves
	 * clear of the backbone instead of lying invisibly on top of it. Costs one
	 * simulation node per link; turn off for a rough, faster layout. */
	bendNodes?: boolean;
	/** (Anchored modes) place bubbles deterministically in bp-proportional lanes
	 * above the reference instead of force-relaxing them (see laneLayout.ts). */
	lanes?: boolean;
	/** Sample name to anchor the backbone on (its path is preferred as backbone). */
	referenceSample?: string;
	/** Which named layout mode to use. Anchored modes ('stacked', 'classic')
	 * lay out along the reference backbone; free modes ('fm3', 'simple-force',
	 * 'flow', 'layered', 'radial') ignore the backbone for positioning and run a
	 * force simulation tuned per mode (see layoutModes.ts). Defaults to 'stacked'. */
	mode?: LayoutMode;
	/** Straighten one chosen haplotype: pin its non-backbone segments to a single
	 * horizontal line above the reference, laid out left-to-right in walk order so
	 * that walk's alt alleles read as a second genome-browser track anchored near
	 * their reference attachments — while every other bubble still force-relaxes.
	 * Steps are *displayed* segment ids (already projected onto the shown graph),
	 * in traversal order with orientation; backbone segments in the list stay on
	 * the reference line and only advance the horizontal cursor. */
	straightenPath?: { id: string; orient: '+' | '-' }[];
	/** 'assembly' mode: which of its parts are on (see assemblyLayout.ts). */
	assembly?: Partial<AssemblyOptions>;
}

const DEFAULTS: Required<Omit<LayoutOptions, 'referenceSample' | 'mode' | 'straightenPath' | 'assembly'>> = {
	targetTotalSubNodes: 2500,
	// Even the longest segment is only split into a handful of sub-nodes: the chain
	// exists so a strand can *bend* around bubbles, not to trace fine detail, and
	// past ~6 edges the extra nodes just wiggle independently under charge repulsion
	// and read as jagged. The canvas smooths the few points it does get into a curve
	// (see traceSmooth in GraphCanvas), so a short, gently-curved chain looks better
	// than a long, noisy one — and costs far less to simulate.
	maxEdgesPerSegment: 6,
	unitEdgeLength: 18,
	iterations: 350,
	bendNodes: true,
	lanes: false
};

/** Vertical spacing between stacked components' backbone baselines. */
const COMPONENT_V_GAP = 500;
/** Floor for the per-BFS-hop vertical offset of a bubble node. The actual step
 * is derived from the backbone's width (see bubbleYStep) so the graph keeps a
 * readable aspect ratio instead of flattening as the locus gets wider. */
const BUBBLE_Y_STEP = 70;
/** Ceiling for that derived step, so a whole-chromosome span stays bounded. */
const MAX_BUBBLE_Y_STEP = 4000;
/** Backbone width : one unit of vertical offset. */
const BUBBLE_Y_STEP_DIVISOR = 20;
/** Vertical gap (in bubble-Y-steps) from the reference down to the straightened
 * walk's track. Close enough that the walk reads as a second track just under the
 * reference, not a distant line with tall connectors. */
const STRAIGHTEN_GAP_STEPS = 1.35;
/** Pull back toward each bubble node's spot on its loop, in x and y. Gentle in x
 * so neighbouring strands can still push each other apart sideways. */
const ANCHOR_X_STRENGTH = 0.03;
const SPREAD_Y_STRENGTH = 0.15;
/** Bubble strands' personal space (see beadForce): bead radius as a fraction of
 * a strand's node spacing, and how hard overlapping beads are pushed apart. */
const BEAD_RADIUS_PER_SPACING = 0.33;
const BEAD_STRENGTH = 0.3;
/** How far toward the reference a bubble node may be pushed, as a fraction of
 * the height its spot on the loop asks for (see enforceRoom). */
const FLOOR_PER_PLANNED = 0.5;
/** Skyline mode: vertical spacing between bubble lanes, in bubble-Y-steps. */
const LANE_GAP_STEPS = 0.5;
/** Minimum distance (in world units) a free node is pushed to keep from the backbone line. */
const MIN_BASELINE_CLEARANCE_FACTOR = 4.5;
/** Gain on the baseline-avoidance push (higher converges to the clearance target faster). */
const BASELINE_PUSH_GAIN = 0.3;

// ============================================================================
// Reference-free layout
//
// The anchored path below pins a backbone to a straight axis and hangs
// everything off it. The free modes instead give the force simulation a
// mode-specific seed and force mix and let the graph settle into its own shape,
// with no reference axis. They reuse the same segment chains, structural links
// and bend nodes — only the seeding and the forces differ.
// ============================================================================

interface FreeCtx {
	graph: GfaGraph;
	nodesById: Map<string, SimNode>;
	chains: SegmentChain[];
	chainById: Map<string, SegmentChain>;
	structuralLinkPaths: LayoutResult['structuralLinkPaths'];
	links: SimLink[];
	chainPxLength: Map<string, number>;
	unit: number;
	iterations: number;
	params: RefFreeParams;
}

/** Lay a segment's sub-node chain out as a short strand of its true length
 * through `center`, oriented along `angle`, so the simulation starts from a
 * strand with real extent instead of a collapsed point it then has to unfold. */
function placeChain(
	chain: SegmentChain,
	cx: number,
	cy: number,
	angle: number,
	span: number,
	unit: number,
	nodesById: Map<string, SimNode>
) {
	const numEdges = chain.nodeIds.length - 1;
	const dx = Math.cos(angle);
	const dy = Math.sin(angle);
	chain.nodeIds.forEach((id, i) => {
		const t = numEdges === 0 ? 0 : i / numEdges - 0.5;
		const node = nodesById.get(id)!;
		node.x = cx + dx * t * span + stableUnit(id) * 4;
		node.y = cy + dy * t * span + stableUnit(id + ':y') * 4;
		node.componentBaselineY = cy;
	});
}

function spanOf(ctx: FreeCtx, chain: SegmentChain): number {
	return ctx.chainPxLength.get(chain.segId) ?? (chain.nodeIds.length - 1) * ctx.unit;
}

/** Unweighted BFS from `start` over the adjacency, returning hop distance to
 * every reachable node and the parent tree. */
function bfsHops(
	start: string,
	adjacency: Map<string, Set<string>>
): { dist: Map<string, number>; parent: Map<string, string | null> } {
	const dist = new Map<string, number>([[start, 0]]);
	const parent = new Map<string, string | null>([[start, null]]);
	const queue = [start];
	let head = 0;
	while (head < queue.length) {
		const node = queue[head++];
		const d = dist.get(node)!;
		for (const nb of adjacency.get(node) ?? []) {
			if (dist.has(nb)) continue;
			dist.set(nb, d + 1);
			parent.set(nb, node);
			queue.push(nb);
		}
	}
	return { dist, parent };
}

/** Farthest key in a distance map (breaks ties by id for determinism). */
function farthest(dist: Map<string, number>): string {
	let best = '';
	let bestD = -1;
	for (const [id, d] of dist) {
		if (d > bestD || (d === bestD && id < best)) {
			bestD = d;
			best = id;
		}
	}
	return best;
}

// --- Seeding strategies ------------------------------------------------------

/** Scatter each chain over a square whose side grows with node count, so a big
 * graph starts spread out (a tiny box would pack everything into one dense knot
 * that charge repulsion then has to slowly blow apart). Used by simple-force. */
function seedScatter(ctx: FreeCtx) {
	const n = Math.max(1, ctx.chains.length);
	const spread = Math.max(ctx.unit * 20, ctx.unit * 3 * Math.sqrt(n));
	for (const chain of ctx.chains) {
		const cx = stableUnit(chain.segId + ':cx') * 2 * spread;
		const cy = stableUnit(chain.segId + ':cy') * 2 * spread;
		const angle = stableUnit(chain.segId + ':ang') * 2 * Math.PI;
		placeChain(chain, cx, cy, angle, spanOf(ctx, chain), ctx.unit, ctx.nodesById);
	}
}

/** Left-to-right layering by graph distance: a double BFS sweep finds a
 * diameter endpoint per component, and each segment's x is its hop-distance from
 * that endpoint. A forceX (added in runFreeLayout) then holds that x while
 * charge/collide spread the layers vertically. Reference-free direction. */
function seedLayered(ctx: FreeCtx) {
	const adjacency = buildAdjacency(ctx.graph);
	const seen = new Set<string>();
	const xStep = ctx.unit * 7;
	// Process one connected component at a time, stacking them vertically.
	let componentRow = 0;
	for (const startSeg of adjacency.keys()) {
		if (seen.has(startSeg)) continue;
		// Double sweep: arbitrary -> farthest A -> distances from A across this component.
		const sweep1 = bfsHops(startSeg, adjacency);
		const endA = farthest(sweep1.dist);
		const { dist } = bfsHops(endA, adjacency);
		let maxHop = 0;
		for (const [id, d] of dist) {
			seen.add(id);
			if (d > maxHop) maxHop = d;
		}
		const rowY = componentRow * ctx.unit * 40;
		for (const chain of ctx.chains) {
			const hop = dist.get(chain.segId);
			if (hop === undefined) continue;
			const cx = hop * xStep;
			const cy = rowY + stableUnit(chain.segId + ':ly') * ctx.unit * 12;
			placeChain(chain, cx, cy, 0, spanOf(ctx, chain), ctx.unit, ctx.nodesById);
			for (const id of chain.nodeIds) ctx.nodesById.get(id)!.targetX = cx;
		}
		componentRow++;
	}
}

/** Sugiyama-style layered ("DAG") seeding. Three classic phases:
 *
 *  1. Rank assignment — each segment's x is its longest incoming path in bp
 *     (cycle-safe: a back-edge into a node still on the DFS stack contributes 0).
 *     This is the reference-free analogue of a genomic axis: left-to-right by
 *     sequence distance, but with no chosen reference path.
 *  2. Crossing minimisation — bucket segments into layers by rank, then run the
 *     barycenter heuristic (repeatedly reorder each layer by the mean row of its
 *     neighbours in the adjacent layer), which is the standard, cheap way to cut
 *     edge crossings in layered drawings.
 *  3. Coordinate assignment — place each chain horizontally across its rank at the
 *     row the ordering earned it. A light relaxation afterwards only resolves
 *     overlaps; forceX holds the ranks (see runFreeLayout).
 */
function seedDag(ctx: FreeCtx) {
	const unit = ctx.unit;
	const has = (id: string) => ctx.chainById.has(id);
	const span = (id: string) => ctx.chainPxLength.get(id) ?? unit;

	// Directed predecessors/successors over the segments we're laying out.
	const pred = new Map<string, string[]>();
	const succ = new Map<string, string[]>();
	for (const chain of ctx.chains) {
		pred.set(chain.segId, []);
		succ.set(chain.segId, []);
	}
	for (const link of ctx.graph.links) {
		if (link.from === link.to || !has(link.from) || !has(link.to)) continue;
		succ.get(link.from)!.push(link.to);
		pred.get(link.to)!.push(link.from);
	}

	// (1) Rank x = longest incoming path in bp. DFS with a visiting stack breaks
	// cycles by treating an edge back into an in-progress node as distance 0.
	const xOf = new Map<string, number>();
	const state = new Map<string, 0 | 1 | 2>();
	const longestX = (seg: string): number => {
		const s = state.get(seg) ?? 0;
		if (s === 2) return xOf.get(seg)!;
		if (s === 1) return 0;
		state.set(seg, 1);
		let x = 0;
		for (const p of pred.get(seg) ?? []) x = Math.max(x, longestX(p) + span(p));
		xOf.set(seg, x);
		state.set(seg, 2);
		return x;
	};
	for (const chain of ctx.chains) longestX(chain.segId);

	// (2) Bucket into layers by rank, then barycenter-order each layer.
	const sortedSpans = ctx.chains.map((c) => span(c.segId)).sort((a, b) => a - b);
	const bucket = Math.max(unit * 4, sortedSpans[sortedSpans.length >> 1] ?? unit * 4);
	const layerOf = new Map<string, number>();
	const layers = new Map<number, string[]>();
	for (const chain of ctx.chains) {
		const L = Math.round((xOf.get(chain.segId) ?? 0) / bucket);
		layerOf.set(chain.segId, L);
		(layers.get(L) ?? layers.set(L, []).get(L)!).push(chain.segId);
	}
	const layerKeys = [...layers.keys()].sort((a, b) => a - b);
	for (const k of layerKeys) layers.get(k)!.sort(); // deterministic start
	const rowOf = new Map<string, number>();
	const reindex = () => {
		for (const k of layerKeys) layers.get(k)!.forEach((s, i) => rowOf.set(s, i));
	};
	reindex();
	const barycenter = (seg: string, neigh: Map<string, string[]>): number => {
		let sum = 0;
		let n = 0;
		for (const m of neigh.get(seg) ?? []) {
			const r = rowOf.get(m);
			if (r !== undefined) {
				sum += r;
				n++;
			}
		}
		return n ? sum / n : (rowOf.get(seg) ?? 0);
	};
	for (let iter = 0; iter < 8; iter++) {
		const down = iter % 2 === 0;
		const order = down ? layerKeys : [...layerKeys].reverse();
		const from = down ? pred : succ;
		for (const k of order) {
			const arr = layers.get(k)!;
			const key = new Map(arr.map((s) => [s, barycenter(s, from)]));
			arr.sort((a, b) => key.get(a)! - key.get(b)! || (a < b ? -1 : 1));
			arr.forEach((s, i) => rowOf.set(s, i));
		}
	}

	// (3) Lay each chain out horizontally across its rank, at its ordered row.
	const rowGap = unit * 5;
	for (const chain of ctx.chains) {
		const L = layerOf.get(chain.segId)!;
		const layerArr = layers.get(L)!;
		const cy = (rowOf.get(chain.segId)! - (layerArr.length - 1) / 2) * rowGap;
		const x0 = xOf.get(chain.segId) ?? 0;
		const sp = span(chain.segId);
		const numEdges = chain.nodeIds.length - 1;
		chain.nodeIds.forEach((id, i) => {
			const t = numEdges === 0 ? 0 : i / numEdges;
			const node = ctx.nodesById.get(id)!;
			node.x = x0 + t * sp + stableUnit(id) * 2;
			node.y = cy + stableUnit(id + ':y') * 2;
			node.componentBaselineY = cy;
			node.targetX = node.x; // forceX holds the rank during relaxation
		});
	}
}

/** Grow outward from a central node: BFS depth becomes radius, and each node's
 * angle is fixed by its order of first discovery, so the graph fans out into a
 * radial overview of its topology. */
function seedRadial(ctx: FreeCtx) {
	const adjacency = buildAdjacency(ctx.graph);
	const seen = new Set<string>();
	const ringGap = ctx.unit * 14;
	let clusterCenterX = 0;
	for (const startSeg of adjacency.keys()) {
		if (seen.has(startSeg)) continue;
		// Center = midpoint of the diameter (farthest-from-farthest), a stable hub.
		const sweep1 = bfsHops(startSeg, adjacency);
		const endA = farthest(sweep1.dist);
		const sweepA = bfsHops(endA, adjacency);
		const endB = farthest(sweepA.dist);
		// Walk halfway back along A->B to find a central node.
		let center = endB;
		const halfWay = Math.floor((sweepA.dist.get(endB) ?? 0) / 2);
		while ((sweepA.dist.get(center) ?? 0) > halfWay) {
			const p = sweepA.parent.get(center);
			if (!p) break;
			center = p;
		}
		const { dist } = bfsHops(center, adjacency);
		const members: string[] = [];
		let maxDepth = 0;
		for (const [id, d] of dist) {
			seen.add(id);
			members.push(id);
			if (d > maxDepth) maxDepth = d;
		}
		members.sort();
		const total = members.length;
		const radius = (maxDepth + 1) * ringGap;
		const originX = clusterCenterX;
		members.forEach((segId, i) => {
			const chain = ctx.chainById.get(segId);
			if (!chain) return;
			const depth = dist.get(segId) ?? 0;
			const angle = (i / total) * 2 * Math.PI;
			const r = depth * ringGap;
			const cx = originX + Math.cos(angle) * r;
			const cy = Math.sin(angle) * r;
			placeChain(chain, cx, cy, angle + Math.PI / 2, spanOf(ctx, chain), ctx.unit, ctx.nodesById);
		});
		clusterCenterX += radius * 2 + ringGap * 4;
	}
}

/** FM³ seeding: run the multilevel FM³ engine on the *segment* graph (one node
 * per segment, not per bead) to get a clean, untangled centre for each segment,
 * then lay each segment's bead chain out through that centre, oriented along the
 * local flow (the principal axis of the directions to its neighbours). The final
 * relaxation in runFreeLayout then bends the strands into the characteristic
 * noodle look. See fm3.ts for the algorithm. */
function seedFm3(ctx: FreeCtx) {
	const segIds = ctx.chains.map((c) => c.segId);
	const spanFor = (id: string) => ctx.chainPxLength.get(id) ?? ctx.unit;

	// One FM³ edge per graph link between two laid-out segments (deduped, and
	// self-loops dropped). Desired length ≈ half of each segment's on-screen span
	// plus a gap, so two linked segments' ends meet rather than their centres.
	const edgeSeen = new Set<string>();
	const edges: Fm3Edge[] = [];
	for (const link of ctx.graph.links) {
		if (link.from === link.to) continue;
		if (!ctx.chainById.has(link.from) || !ctx.chainById.has(link.to)) continue;
		const key = link.from < link.to ? `${link.from} ${link.to}` : `${link.to} ${link.from}`;
		if (edgeSeen.has(key)) continue;
		edgeSeen.add(key);
		edges.push({
			a: link.from,
			b: link.to,
			len: (spanFor(link.from) + spanFor(link.to)) / 2 + ctx.unit
		});
	}

	const { pos } = runFm3({ nodes: segIds, edges, iterationsPerLevel: 40 });

	// Orientation: lay each segment's strand along the principal axis of the
	// directions from its centre to its neighbours' centres (a 2×2 orientation
	// tensor). For a path-like node that's the line through its two neighbours, so
	// the strand lies along the flow instead of at a random angle.
	const adjacency = buildAdjacency(ctx.graph);
	for (const chain of ctx.chains) {
		const c = pos.get(chain.segId) ?? { x: 0, y: 0 };
		let sxx = 0;
		let sxy = 0;
		let syy = 0;
		let count = 0;
		for (const nb of adjacency.get(chain.segId) ?? []) {
			const p = pos.get(nb);
			if (!p) continue;
			let dx = p.x - c.x;
			let dy = p.y - c.y;
			const mag = Math.hypot(dx, dy);
			if (mag < 1e-6) continue;
			dx /= mag;
			dy /= mag;
			sxx += dx * dx;
			sxy += dx * dy;
			syy += dy * dy;
			count++;
		}
		const angle = count > 0 ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : stableUnit(chain.segId) * Math.PI;
		placeChain(chain, c.x, c.y, angle, spanOf(ctx, chain), ctx.unit, ctx.nodesById);
	}
}

/** Bend nodes seed at the midpoint of their (now-positioned) endpoints, nudged
 * off the straight line so the simulation has a direction to bow the curve. */
function seedBendNodes(ctx: FreeCtx) {
	for (const path of ctx.structuralLinkPaths) {
		if (!path.bendNode) continue;
		const bend = ctx.nodesById.get(path.bendNode)!;
		const a = ctx.nodesById.get(path.fromNode)!;
		const b = ctx.nodesById.get(path.toNode)!;
		bend.x = (a.x + b.x) / 2 + stableUnit(path.bendNode) * ctx.unit;
		bend.y = (a.y + b.y) / 2 + stableUnit(path.bendNode + ':y') * ctx.unit;
	}
}

/** Seed + relax a reference-free layout in place, mutating node positions. */
function runFreeLayout(ctx: FreeCtx) {
	const { params } = ctx;

	if (params.seeding === 'fm3') seedFm3(ctx);
	else if (params.seeding === 'layered') seedLayered(ctx);
	else if (params.seeding === 'radial') seedRadial(ctx);
	else if (params.seeding === 'dag') seedDag(ctx);
	else seedScatter(ctx);

	seedBendNodes(ctx);

	// Loosen (or tighten) the structural links per mode. Chain links keep their
	// bp-proportional distance and full strength, so segments stay their true
	// length; only the links *between* segments get the mode's spread treatment.
	for (const link of ctx.links) {
		if (link.kind !== 'structural') continue;
		link.distance *= params.linkDistanceScale;
		link.strength = params.linkStrength;
	}

	const nodeArray = Array.from(ctx.nodesById.values());

	const simulation = forceSimulation(nodeArray)
		.force(
			'link',
			forceLink<SimNode, SimLink>(ctx.links)
				.id((d) => d.id)
				.distance((d) => d.distance)
				.strength((d) => d.strength)
		)
		.force('charge', forceManyBody().strength(params.charge).distanceMax(params.chargeDistanceMax))
		.force('collide', forceCollide(params.collide))
		.force(
			'flowX',
			// Both the force-relaxed 'flow' (layered) and the deterministic 'layered'
			// (dag) modes pin each node's rank on x while the sim tidies the rows.
			params.seeding === 'layered' || params.seeding === 'dag'
				? forceX<SimNode>((d) => d.targetX ?? d.x).strength((d) =>
						d.targetX != null ? (params.seeding === 'dag' ? 0.6 : 0.35) : 0
					)
				: null
		)
		.stop();

	const n = Math.max(1, ctx.iterations);
	for (let i = 0; i < n; i++) simulation.tick();
}

/** Build the LayoutResult from finished node positions. Shared by the anchored
 * and free paths: only how the nodes got their positions differs; the coverage
 * heatmap, segment lengths and backbone metadata are computed the same way.
 * `backboneSegIds` is the set of segments to draw as the reference axis — the
 * anchored path fills it; free modes pass an empty set so nothing is singled out
 * as a backbone. */
/** Segments of the backbones that are a real reference path (not a computed
 * longest path, and the chosen reference sample's when one is named). */
function referenceSegments(backbones: Backbone[], referenceSample?: string): Set<string> {
	const out = new Set<string>();
	for (const b of backbones) {
		if (b.source === 'synthetic') continue;
		if (referenceSample && b.source.split('#')[0] !== referenceSample) continue;
		for (const st of b.steps) out.add(st.id);
	}
	return out;
}

export function assembleResult(
	graph: GfaGraph,
	backbones: Backbone[],
	backboneSegIds: Set<string>,
	nodesById: Map<string, SimNode>,
	chains: SegmentChain[],
	structuralLinkPaths: LayoutResult['structuralLinkPaths']
): LayoutResult {
	const backboneInfo: BackboneInfo[] = backbones.map((b, i) => ({
		componentId: i,
		source: b.source,
		totalLength: b.totalLength
	}));

	const segmentLengths = new Map<string, number>();
	for (const seg of graph.segments.values()) segmentLengths.set(seg.id, seg.length);

	// Coverage heatmap: distinct non-reference walks per segment. In reduced mode
	// this is precomputed server-side (segment.coverage from the `WC` tag), since
	// the non-reference walks were aggregated away to save memory. Otherwise (full
	// GFA / playground fixtures) count it from the walks directly, excluding
	// whichever path was picked as the backbone for its component.
	const pathCoverage = new Map<string, number>();
	const hasReducedCoverage = [...graph.segments.values()].some((s) => s.coverage !== undefined);
	if (hasReducedCoverage) {
		for (const seg of graph.segments.values()) pathCoverage.set(seg.id, seg.coverage ?? 0);
	} else {
		const backboneSourceNames = new Set(
			backbones.filter((b) => b.source !== 'synthetic').map((b) => b.source)
		);
		for (const path of graph.paths) {
			if (backboneSourceNames.has(path.name)) continue;
			const seenInThisPath = new Set<string>();
			for (const step of path.steps) {
				if (seenInThisPath.has(step.id)) continue; // count each path once per segment
				seenInThisPath.add(step.id);
				pathCoverage.set(step.id, (pathCoverage.get(step.id) ?? 0) + 1);
			}
		}
	}
	let maxPathCoverage = 0;
	for (const count of pathCoverage.values()) maxPathCoverage = Math.max(maxPathCoverage, count);

	return {
		nodesById,
		chains,
		structuralLinkPaths,
		backbones: backboneInfo,
		backboneSegIds,
		segmentLengths,
		pathCoverage,
		maxPathCoverage
	};
}

export function buildAndRunLayout(graph: GfaGraph, options: LayoutOptions = {}): LayoutResult {
	// The mode config supplies the defaults for the anchored primitives (one-sided,
	// anchoring, bendiness), so calling with just `{ mode }` already gives that
	// mode's look. Explicit options still win — that's how the UI's advanced
	// overrides and rough-mode's straight-strand force apply on top.
	const modeCfg = getModeConfig(options.mode);
	if (modeCfg.assembly) {
		return buildAssemblyLayout(graph, {
			referenceSample: options.referenceSample,
			assembly: options.assembly,
			iterations: options.iterations
		});
	}
	const opts = {
		...DEFAULTS,
		lanes: modeCfg.lanes,
		bendNodes: modeCfg.bendNodes,
		...options
	};

	// Pixels-per-bp is fixed from the REFERENCE backbone's own bp total, not the
	// whole graph's summed segment length. Keying it to all segments meant the
	// scale shifted every time the graph was simplified (removing alt nodes
	// shrinks total sequence even though the reference itself never changes),
	// and — combined with clamping every chain to a fixed edge count × a fixed
	// px-per-edge — meant a 1bp node and a 40kb node could render at the same
	// on-screen length, or a tiny deletion-marker node could look stretched.
	// Backbones are sorted by length descending and prefer the reference sample
	// (see computeBackbones), so backbones[0] is the reference whenever one exists.
	const backbones = computeBackbones(graph, options.referenceSample);
	let totalLength = 0;
	for (const seg of graph.segments.values()) totalLength += Math.max(1, seg.length);
	const refBp = Math.max(1, backbones[0]?.totalLength ?? totalLength);
	const basesPerEdge = Math.max(1, refBp / Math.max(1, opts.targetTotalSubNodes));
	const pxPerBp = opts.unitEdgeLength / basesPerEdge;

	const nodesById = new Map<string, SimNode>();
	const chains: SegmentChain[] = [];
	const links: SimLink[] = [];
	// Total on-screen length assigned to each segment's chain (bp * pxPerBp,
	// clamped by maxEdgesPerSegment only in how many sub-nodes render it smoothly
	// — never in its total length).
	const chainPxLength = new Map<string, number>();

	for (const seg of graph.segments.values()) {
		const segLen = Math.max(1, seg.length);
		const numEdges = Math.min(opts.maxEdgesPerSegment, Math.max(1, Math.ceil(segLen / basesPerEdge)));
		const numNodes = numEdges + 1;
		const totalPx = segLen * pxPerBp;
		const distancePerEdge = totalPx / numEdges;
		chainPxLength.set(seg.id, totalPx);
		const nodeIds: string[] = [];

		for (let i = 0; i < numNodes; i++) {
			const id = `${seg.id}::${i}`;
			nodeIds.push(id);
			nodesById.set(id, {
				id,
				segId: seg.id,
				posIndex: i,
				isChainEnd: i === 0 || i === numNodes - 1,
				x: 0,
				y: 0,
				componentBaselineY: 0
			});
			if (i > 0) {
				links.push({
					source: nodeIds[i - 1],
					target: id,
					distance: distancePerEdge,
					strength: 1,
					kind: 'chain'
				});
			}
		}
		chains.push({ segId: seg.id, nodeIds });
	}

	const chainById = new Map(chains.map((c) => [c.segId, c]));
	const structuralLinkPaths: LayoutResult['structuralLinkPaths'] = [];
	// Sentinel segId for bend nodes: not a real segment, so it's automatically
	// excluded from chains/hit-testing/rendering-as-a-strand — it only exists to
	// give the simulation something to push sideways.
	const BEND_SEG_ID = '__bend__';
	let bendCounter = 0;

	for (const link of graph.links) {
		const fromChain = chainById.get(link.from);
		const toChain = chainById.get(link.to);
		if (!fromChain || !toChain) continue;

		const fromNode =
			link.fromOrient === '+' ? fromChain.nodeIds[fromChain.nodeIds.length - 1] : fromChain.nodeIds[0];
		const toNode = link.toOrient === '+' ? toChain.nodeIds[0] : toChain.nodeIds[toChain.nodeIds.length - 1];

		if (fromNode === toNode) continue;

		// Without bend nodes the link is a single straight edge. They roughly
		// double the simulation's node count (one per link), which is the largest
		// remaining cost on a dense graph — so a rough layout skips them and the
		// canvas falls back to drawing a straight line.
		if (!opts.bendNodes) {
			links.push({
				source: fromNode,
				target: toNode,
				distance: opts.unitEdgeLength,
				strength: 0.3,
				kind: 'structural'
			});
			structuralLinkPaths.push({ from: link.from, to: link.to, fromNode, toNode, bendNode: '' });
			continue;
		}

		const bendNode = `bend::${bendCounter++}`;
		nodesById.set(bendNode, {
			id: bendNode,
			segId: BEND_SEG_ID,
			posIndex: 0,
			isChainEnd: false,
			x: 0,
			y: 0,
			componentBaselineY: 0
		});
		links.push(
			{ source: fromNode, target: bendNode, distance: opts.unitEdgeLength / 2, strength: 0.3, kind: 'structural' },
			{ source: bendNode, target: toNode, distance: opts.unitEdgeLength / 2, strength: 0.3, kind: 'structural' }
		);
		structuralLinkPaths.push({ from: link.from, to: link.to, fromNode, toNode, bendNode });
	}

	// --- Mode dispatch ---
	// Free modes ignore the backbone for positioning: seed + relax the same nodes
	// under a mode-specific force mix, and report an empty backboneSegIds so
	// nothing is drawn as the reference axis. Anchored modes fall through to the
	// backbone-anchored path below. (modeCfg resolved above.)
	if (modeCfg.family === 'free' && modeCfg.refFree) {
		runFreeLayout({
			graph,
			nodesById,
			chains,
			chainById,
			structuralLinkPaths,
			links,
			chainPxLength,
			unit: opts.unitEdgeLength,
			// Precedence: an explicit caller override wins; otherwise the mode's own
			// iteration count (modes with a good seed, like FM³, need far fewer than
			// the 350 default); otherwise the global default. Previously the per-mode
			// count was declared but never read.
			iterations: options.iterations ?? modeCfg.refFree.iterations ?? opts.iterations,
			params: modeCfg.refFree
		});
		const result = assembleResult(graph, backbones, new Set(), nodesById, chains, structuralLinkPaths);
		result.referenceSegIds = referenceSegments(backbones, options.referenceSample);
		return result;
	}

	// --- Backbone anchoring ---
	const assignedSegIds = new Set<string>();
	const anchors = new Map<string, { x: number; y: number }>(); // segId -> midpoint, for the backbone's width

	// In lanes mode each backbone is laid end to end with no gaps between its
	// segments, so the reference axis is linear in bp. The force-relaxed modes
	// keep a unit gap after every segment: their forces are tuned in those units,
	// and the gaps give a stretch of many small reference nodes room to relax.
	const refGap = opts.lanes ? 0 : opts.unitEdgeLength;
	backbones.forEach((backbone, index) => {
		const baselineY = index * COMPONENT_V_GAP;
		let cursorX = 0;

		for (const step of backbone.steps) {
			if (assignedSegIds.has(step.id)) continue; // guard against a path revisiting a segment
			const chain = chainById.get(step.id);
			if (!chain) continue;
			assignedSegIds.add(step.id);

			const numEdges = chain.nodeIds.length - 1;
			const spanLength = chainPxLength.get(step.id) ?? numEdges * opts.unitEdgeLength;

			chain.nodeIds.forEach((nodeId, i) => {
				const node = nodesById.get(nodeId)!;
				const t = numEdges === 0 ? 0 : i / numEdges;
				const localX = step.orient === '+' ? t * spanLength : (1 - t) * spanLength;
				node.x = cursorX + localX;
				node.y = baselineY;
				node.fx = node.x;
				node.fy = node.y;
				node.componentBaselineY = baselineY;
			});

			anchors.set(step.id, { x: cursorX + spanLength / 2, y: baselineY });
			cursorX += spanLength + refGap;
		}
	});

	// Vertical spacing has to scale with the layout's horizontal extent, which is
	// set by the locus's bp span. A fixed step made every real locus render as a
	// flat smear: SMN1 came out 57,366 x 1,085 units — 53:1 — so fitting it to a
	// 1200x460 canvas left the whole vertical structure occupying 23px. Deriving
	// the step from the backbone's width targets a readable aspect ratio instead,
	// clamped so tiny graphs don't explode and huge ones stay bounded.
	let backboneMinX = Infinity;
	let backboneMaxX = -Infinity;
	for (const a of anchors.values()) {
		backboneMinX = Math.min(backboneMinX, a.x);
		backboneMaxX = Math.max(backboneMaxX, a.x);
	}
	const backboneWidth = Number.isFinite(backboneMinX) ? backboneMaxX - backboneMinX : 0;
	const bubbleYStep = Math.max(
		BUBBLE_Y_STEP,
		Math.min(MAX_BUBBLE_Y_STEP, backboneWidth / BUBBLE_Y_STEP_DIVISOR)
	);

	// --- Place every bubble node on a loop of string off the reference ---
	// (see bubbleShape.ts). Each strand gets a smooth arch or balloon as long as
	// the strand itself, and the simulation only has to relax it.
	const adjacency = buildAdjacency(graph);
	const spots = bubbleStringSpots(
		graph,
		chainById,
		chainPxLength,
		(id) => nodesById.get(id)!,
		assignedSegIds,
		opts.unitEdgeLength,
		opts.unitEdgeLength * MIN_BASELINE_CLEARANCE_FACTOR
	);

	// --- Straighten one chosen haplotype into a track below the reference ---
	// The chosen walk's off-backbone segments are pinned to a single horizontal line
	// a clear gap *below* the reference. `straightenY` is that line (component 0's
	// baseline is 0); `straightenSet` is the segments that land on it. The bubbles
	// hanging directly off the walk (a bounded BFS through non-backbone neighbours)
	// get *permission to settle down beside it* — seeded and pulled toward the track
	// rather than being held above with every other bubble — so the walk reads as a
	// self-contained lower track with its own local variation, while unrelated bubbles
	// keep force-relaxing above the reference as usual.
	const straightenY = STRAIGHTEN_GAP_STEPS * bubbleYStep;
	const straightenSet = new Set<string>();
	if (opts.straightenPath) {
		for (const step of opts.straightenPath) {
			if (chainById.has(step.id) && !assignedSegIds.has(step.id)) straightenSet.add(step.id);
		}
	}
	const belowLineSegs = new Set<string>();
	if (straightenSet.size > 0) {
		const BELOW_MAX_HOPS = 6;
		const BELOW_MAX_SEGS = 3000;
		const q: string[] = [];
		const hop = new Map<string, number>();
		for (const s of straightenSet) {
			hop.set(s, 0);
			q.push(s);
		}
		let head = 0;
		while (head < q.length && belowLineSegs.size < BELOW_MAX_SEGS) {
			const cur = q[head++];
			const d = hop.get(cur)!;
			if (d >= BELOW_MAX_HOPS) continue;
			for (const nb of adjacency.get(cur) ?? []) {
				// Don't cross the reference (its nodes are the fixed anchors) and don't
				// re-file a straightened segment or one already reached.
				if (assignedSegIds.has(nb) || straightenSet.has(nb) || hop.has(nb)) continue;
				hop.set(nb, d + 1);
				belowLineSegs.add(nb);
				q.push(nb);
				if (belowLineSegs.size >= BELOW_MAX_SEGS) break;
			}
		}
	}
	// Node ids seeded on the lower side, exempt from the one-sided "stay above" push.
	const belowLineNodeIds = new Set<string>();

	for (const chain of chains) {
		if (assignedSegIds.has(chain.segId)) continue;
		if (straightenSet.has(chain.segId)) continue; // pinned onto the track below (later)
		const below = belowLineSegs.has(chain.segId);
		chain.nodeIds.forEach((nodeId, i) => {
			const node = nodesById.get(nodeId)!;
			const spot = spots.get(nodeId);
			let x: number;
			let y: number;
			if (below) {
				// Bubbles off the straightened walk settle beside its track instead.
				x = spot?.x ?? i * opts.unitEdgeLength;
				y = straightenY;
				belowLineNodeIds.add(nodeId);
			} else if (spot) {
				x = spot.x;
				y = spot.baseY - spot.height;
			} else {
				// Not connected to the reference at all.
				x = i * opts.unitEdgeLength;
				y = -bubbleYStep;
			}
			node.x = x + stableUnit(nodeId) * 6;
			node.y = y + stableUnit(nodeId + ':y') * 6;
			node.componentBaselineY = spot?.baseY ?? 0;
			// Remember where this belongs, so the simulation can pull it back (see
			// anchorForce) and the string keeps its shape instead of crumpling.
			node.anchorX = x;
			node.targetY = y;
			if (spot && !below) node.room = spot.room;
		});
	}

	if (straightenSet.size > 0) {
		// Pin the walk's off-backbone segments along the track, left-to-right in
		// traversal order. Backbone segments in the walk aren't moved (they belong on
		// the reference line); they just advance the horizontal cursor to their right
		// edge, so the alt run that follows starts right at the reference node it
		// branches from — "near its reference connection".
		let cursorX = 0;
		let haveCursor = false;
		for (const step of opts.straightenPath!) {
			const chain = chainById.get(step.id);
			if (!chain) continue;
			if (assignedSegIds.has(step.id)) {
				// A reference segment the chosen walk shares: stays on the backbone.
				// Snap the cursor to its right edge so the next alt run hangs off it.
				let maxX = -Infinity;
				for (const nodeId of chain.nodeIds) maxX = Math.max(maxX, nodesById.get(nodeId)!.x);
				if (Number.isFinite(maxX)) {
					cursorX = maxX;
					haveCursor = true;
				}
				continue;
			}
			const numEdges = chain.nodeIds.length - 1;
			const spanLength = chainPxLength.get(step.id) ?? Math.max(1, numEdges) * opts.unitEdgeLength;
			const startX = haveCursor ? cursorX : 0;
			chain.nodeIds.forEach((nodeId, i) => {
				const node = nodesById.get(nodeId)!;
				const t = numEdges === 0 ? 0 : i / numEdges;
				const localX = step.orient === '+' ? t * spanLength : (1 - t) * spanLength;
				node.x = startX + localX;
				node.y = straightenY;
				node.fx = node.x;
				node.fy = node.y;
				node.componentBaselineY = 0;
			});
			cursorX = startX + spanLength + refGap;
			haveCursor = true;
		}
	}

	// Skyline mode places every bubble directly — no simulation — hanging off the
	// reference and the straightened walk, which are already in place.
	if (opts.lanes) {
		placeBubbleLanes({
			graph,
			nodesById,
			chainById,
			structuralLinkPaths,
			chainPxLength,
			fixedSegIds: new Set([...assignedSegIds, ...straightenSet]),
			laneGap: bubbleYStep * LANE_GAP_STEPS
		});
		return assembleResult(graph, backbones, assignedSegIds, nodesById, chains, structuralLinkPaths);
	}

	// Seed bend nodes at the midpoint of their two endpoints (now that both have
	// real positions), nudged off-axis by a deterministic jitter so the
	// simulation has a direction to push in rather than starting exactly on the
	// line it's meant to bend away from.
	for (const path of structuralLinkPaths) {
		if (!path.bendNode) continue;
		const bend = nodesById.get(path.bendNode)!;
		const a = nodesById.get(path.fromNode)!;
		const b = nodesById.get(path.toNode)!;
		bend.x = (a.x + b.x) / 2 + stableUnit(path.bendNode) * 6;
		bend.y = (a.y + b.y) / 2 - bubbleYStep * 0.4;
		bend.componentBaselineY = a.componentBaselineY;
	}

	const nodeArray = Array.from(nodesById.values());

	// Keeps bubble nodes from drifting on top of the backbone line: general
	// charge repulsion alone isn't reliably strong enough locally (a bubble
	// sitting between two backbone attachment points can have its sideways
	// push mostly cancelled out), so this adds a direct, guaranteed clearance.
	const minBaselineClearance = opts.unitEdgeLength * MIN_BASELINE_CLEARANCE_FACTOR;
	function avoidBaselineForce(alpha: number) {
		for (const node of nodeArray) {
			if (node.fy != null) continue; // backbone nodes are fixed, exempt
			const dy = node.y - node.componentBaselineY;
			// Bubbles that belong to the straightened lower track are held below the
			// reference (off the line), not pushed back up through it.
			if (belowLineNodeIds.has(node.id)) {
				if (dy < minBaselineClearance) {
					const target = node.componentBaselineY + minBaselineClearance;
					node.vy = (node.vy ?? 0) + (target - node.y) * BASELINE_PUSH_GAIN * alpha;
				}
				continue;
			}
			// Bubbles stay above the line: anything that has drifted below it is
			// pushed back up through it, not away from it, so the space below stays
			// clear for the gene track.
			if (dy > -minBaselineClearance) {
				const target = node.componentBaselineY - minBaselineClearance;
				node.vy = (node.vy ?? 0) + (target - node.y) * BASELINE_PUSH_GAIN * alpha;
			}
		}
	}

	// Pulls each bubble node back toward its spot on its loop of string, so the
	// strand keeps that shape while charge and collide only nudge neighbouring
	// strands apart. Without it a bubble slides arbitrarily far from where it
	// attaches.
	function anchorForce(alpha: number) {
		for (const node of nodeArray) {
			if (node.fy != null) continue; // backbone nodes are pinned
			if (node.anchorX != null) {
				node.vx = (node.vx ?? 0) + (node.anchorX - node.x) * ANCHOR_X_STRENGTH * alpha;
			}
			if (node.targetY != null) {
				node.vy = (node.vy ?? 0) + (node.targetY - node.y) * SPREAD_Y_STRENGTH * alpha;
			}
		}
	}

	// Gives every strand a little personal space, so two strands are gently kept
	// from passing through or twisting around each other. Each interior node of a
	// bubble strand is a bead about a third of its spacing along the strand, so
	// neighbouring beads on one strand never push each other. Only bubble beads
	// take part: the reference is pinned, and a strand's two ends are left free so
	// they still meet the strands they link to.
	const beadRadius = new Map<SimNode, number>();
	for (const chain of chains) {
		if (assignedSegIds.has(chain.segId) || chain.nodeIds.length < 3) continue;
		const spacing = (chainPxLength.get(chain.segId) ?? 0) / (chain.nodeIds.length - 1);
		const r = Math.min(bubbleYStep, Math.max(8, spacing * BEAD_RADIUS_PER_SPACING));
		for (const id of chain.nodeIds.slice(1, -1)) beadRadius.set(nodesById.get(id)!, r);
	}
	const beads = forceCollide<SimNode>((d) => beadRadius.get(d) ?? 0).strength(BEAD_STRENGTH);
	const beadForce = Object.assign((alpha: number) => beads(alpha), {
		initialize: (_nodes: SimNode[], random: () => number) => beads.initialize([...beadRadius.keys()], random)
	});

	const simulation = forceSimulation(nodeArray)
		.force(
			'link',
			forceLink<SimNode, SimLink>(links)
				.id((d) => d.id)
				.distance((d) => d.distance)
				.strength((d) => d.strength)
		)
		.force('charge', forceManyBody().strength(-40).distanceMax(400))
		.force('collide', forceCollide(8))
		.force('beads', beadForce)
		.force('anchor', anchorForce)
		.force('avoidBaseline', avoidBaselineForce)
		.stop();

	// Hard walls, applied after every step: a bubble never sinks to (or through)
	// the reference line, and never leaves its variant's room. The forces above
	// only push; near the end of the run, when every force is weak, bead spacing
	// and links could still win and leave strands under the line or tangled into
	// a neighbour's space. One shared floor flattened everything a dense tangle
	// pushed down onto a single indistinguishable line, so each node's floor is
	// its own: a clearance that varies per segment (1–2×, the same along a strand
	// so it stays smooth), or half the height its spot on the loop asks for,
	// whichever is higher.
	const floorHeight = new Map<SimNode, number>();
	for (const node of nodeArray) {
		const planned = node.targetY != null ? node.componentBaselineY - node.targetY : 0;
		const clearance =
			minBaselineClearance * (1.5 + stableUnit(`floor:${node.segId === BEND_SEG_ID ? node.id : node.segId}`));
		floorHeight.set(node, Math.max(clearance, planned * FLOOR_PER_PLANNED));
	}
	function enforceRoom() {
		for (const node of nodeArray) {
			if (node.fy != null || belowLineNodeIds.has(node.id)) continue;
			const top = node.componentBaselineY - floorHeight.get(node)!;
			if (node.y > top) {
				node.y = top;
				if ((node.vy ?? 0) > 0) node.vy = 0;
			}
			if (node.room) {
				const [lo, hi] = node.room;
				if (node.x < lo || node.x > hi) {
					node.x = Math.min(hi, Math.max(lo, node.x));
					node.vx = 0;
				}
			}
		}
	}

	const n = Math.max(1, opts.iterations);
	for (let i = 0; i < n; i++) {
		simulation.tick();
		enforceRoom();
	}

	return assembleResult(graph, backbones, assignedSegIds, nodesById, chains, structuralLinkPaths);
}
