import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import type { GfaGraph } from './types';
import { buildAdjacency, computeBackbones } from './backbone';
import { stableUnit } from './prng';

/**
 * Layout approach: each segment becomes a *chain* of sub-nodes whose total
 * chain length is proportional to the segment's sequence length (drawn as a
 * strand, conceptually inspired by Bandage's rendering but implemented
 * independently with d3-force rather than OGDF/FMMM).
 *
 * On top of that, one "backbone" path per connected component (see
 * backbone.ts) is anchored to a straight, deterministic horizontal line via
 * d3-force's fixed-position nodes (fx/fy) — a genome-browser-style coordinate
 * axis. Everything else (variant bubbles, alt alleles) is seeded near its
 * backbone attachment point and only locally relaxed. This makes the layout
 * reproducible and comparable across similar graphs, instead of a force
 * simulation's usual rotation/reflection/local-minimum ambiguity.
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
	/** Where this node was seeded relative to the backbone: the x of the reference
	 * attachment it hangs off, and the y its BFS depth earns it. Bubbles are pulled
	 * back toward these so they stay near the reference position they belong to,
	 * and so depth actually spreads them vertically instead of everything piling
	 * up against the baseline. Undefined for backbone nodes (which are pinned). */
	anchorX?: number;
	targetY?: number;
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
	segmentLengths: Map<string, number>;
	/** Count of non-reference (non-backbone) paths traversing each segment. */
	pathCoverage: Map<string, number>;
	maxPathCoverage: number;
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
	/** Keep every non-reference bubble on one side of the backbone (above it)
	 * instead of letting them fall either way. Halves the vertical spread and
	 * leaves the space below the reference line free for coordinate tracks. */
	bubblesAbove?: boolean;
	/** Route each structural link through an invisible bend node so it curves
	 * clear of the backbone instead of lying invisibly on top of it. Costs one
	 * simulation node per link; turn off for a rough, faster layout. */
	bendNodes?: boolean;
	/** Sample name to anchor the backbone on (its path is preferred as backbone). */
	referenceSample?: string;
}

const DEFAULTS: Required<Omit<LayoutOptions, 'referenceSample'>> = {
	targetTotalSubNodes: 2500,
	maxEdgesPerSegment: 60,
	unitEdgeLength: 18,
	iterations: 350,
	bendNodes: true,
	bubblesAbove: false
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
/** Ceiling on the sqrt(depth) multiplier, so the deepest nodes in a tangled
 * graph stay within a few steps of the backbone instead of defining the whole
 * canvas's scale. */
const MAX_DEPTH_OFFSET = 3;
/** Pull back toward the reference x a bubble attaches to (stops long sideways drift). */
const ANCHOR_X_STRENGTH = 0.12;
/** Only nodes this close to the backbone get that pull — see where it's set. */
const ANCHOR_X_MAX_HOPS = 2;
/** Pull toward the depth-derived y (spreads bubbles vertically). */
const SPREAD_Y_STRENGTH = 0.15;
/** Minimum distance (in world units) a free node is pushed to keep from the backbone line. */
const MIN_BASELINE_CLEARANCE_FACTOR = 4.5;
/** Gain on the baseline-avoidance push (higher converges to the clearance target faster). */
const BASELINE_PUSH_GAIN = 0.3;

export function buildAndRunLayout(graph: GfaGraph, options: LayoutOptions = {}): LayoutResult {
	const opts = { ...DEFAULTS, ...options };

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

	// --- Backbone anchoring ---
	const assignedSegIds = new Set<string>();
	const anchors = new Map<string, { x: number; y: number }>(); // segId -> midpoint, for BFS seeding

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
			cursorX += spanLength + opts.unitEdgeLength;
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

	// --- Seed off-backbone (bubble) nodes near their nearest backbone attachment ---
	const adjacency = buildAdjacency(graph);
	const nearestAnchor = new Map<string, { x: number; y: number; hops: number }>();
	const bfsQueue: string[] = [];
	for (const segId of assignedSegIds) {
		const anchor = anchors.get(segId);
		if (!anchor) continue;
		nearestAnchor.set(segId, { ...anchor, hops: 0 });
		bfsQueue.push(segId);
	}
	let qHead = 0;
	while (qHead < bfsQueue.length) {
		const current = bfsQueue[qHead++];
		const currentInfo = nearestAnchor.get(current)!;
		for (const neighbor of adjacency.get(current) ?? []) {
			if (nearestAnchor.has(neighbor)) continue;
			nearestAnchor.set(neighbor, { x: currentInfo.x, y: currentInfo.y, hops: currentInfo.hops + 1 });
			bfsQueue.push(neighbor);
		}
	}

	for (const chain of chains) {
		if (assignedSegIds.has(chain.segId)) continue;
		const anchor = nearestAnchor.get(chain.segId) ?? { x: 0, y: 0, hops: 1 };
		const sign = opts.bubblesAbove ? -1 : stableUnit(chain.segId) >= 0 ? 1 : -1;
		const baseX = anchor.x + stableUnit(chain.segId) * opts.unitEdgeLength * 2;
		// Depth has to grow the offset sub-linearly and stop growing at some point.
		// Multiplying by hops directly meant a deep BFS (routine in an
		// unsimplified graph) flung a handful of nodes thousands of units out —
		// fit-to-view then zoomed out to contain them and squashed everything
		// else into a band. sqrt spaces the first few levels clearly and the cap
		// keeps the tail bounded.
		const depth = Math.min(Math.sqrt(anchor.hops), MAX_DEPTH_OFFSET);
		const baseY = anchor.y + sign * depth * bubbleYStep;

		chain.nodeIds.forEach((nodeId, i) => {
			const node = nodesById.get(nodeId)!;
			node.x = baseX + i * opts.unitEdgeLength + stableUnit(nodeId) * 6;
			node.y = baseY + stableUnit(nodeId + ':y') * 6;
			node.componentBaselineY = anchor.y;
			// Remember where this belongs, so the simulation can pull it back
			// (see anchorForce). The x anchor applies only to nodes that actually
			// attach to the backbone nearby: everything in a BFS subtree shares one
			// anchor, so pulling deep nodes to it dragged whole clusters onto a
			// single x and left their links stretching across the canvas. Past a
			// hop or two, the link forces place a node better than its anchor can.
			if (anchor.hops <= ANCHOR_X_MAX_HOPS) {
				node.anchorX = anchor.x + i * opts.unitEdgeLength;
			}
			node.targetY = baseY;
		});
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
		const bendSign = opts.bubblesAbove ? -1 : stableUnit(path.bendNode + ':y') >= 0 ? 1 : -1;
		bend.y = (a.y + b.y) / 2 + bendSign * bubbleYStep * 0.4;
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
			const absDy = Math.abs(dy);
			// One-sided: anything that has drifted below the line is pushed back up
			// through it, not away from it, so the space below stays clear.
			if (opts.bubblesAbove && dy > -minBaselineClearance) {
				const target = node.componentBaselineY - minBaselineClearance;
				node.vy = (node.vy ?? 0) + (target - node.y) * BASELINE_PUSH_GAIN * alpha;
				continue;
			}
			if (absDy < minBaselineClearance) {
				const dir = dy !== 0 ? Math.sign(dy) : stableUnit(node.id) >= 0 ? 1 : -1;
				const push = (minBaselineClearance - absDy) * BASELINE_PUSH_GAIN * alpha;
				node.vy = (node.vy ?? 0) + dir * push;
			}
		}
	}

	// Pulls each bubble node back toward where it was seeded. Without this,
	// charge repulsion is the only thing acting along x, so a bubble slides
	// arbitrarily far from the reference position it actually attaches to — the
	// long thin strands trailing across the canvas. The y half does the opposite
	// job: it *spreads*, since a node's target grows with its BFS depth, where
	// the clearance force below only ever enforced a minimum and so left
	// everything stacked in one band against the backbone.
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

	const simulation = forceSimulation(nodeArray)
		.force(
			'link',
			forceLink<SimNode, SimLink>(links)
				.id((d) => d.id)
				.distance((d) => d.distance)
				.strength((d) => d.strength)
		)
		.force('charge', forceManyBody().strength(-40).distanceMax(400))
		.force('collide', forceCollide(5))
		.force('anchor', anchorForce)
		.force('avoidBaseline', avoidBaselineForce)
		.stop();

	const n = Math.max(1, opts.iterations);
	for (let i = 0; i < n; i++) simulation.tick();

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
		backboneSegIds: assignedSegIds,
		segmentLengths,
		pathCoverage,
		maxPathCoverage
	};
}
