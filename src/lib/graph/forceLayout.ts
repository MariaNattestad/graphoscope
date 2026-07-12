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
	/** Sample name to anchor the backbone on (its path is preferred as backbone). */
	referenceSample?: string;
}

const DEFAULTS: Required<Omit<LayoutOptions, 'referenceSample'>> = {
	targetTotalSubNodes: 2500,
	maxEdgesPerSegment: 60,
	unitEdgeLength: 18,
	iterations: 350
};

/** Vertical spacing between stacked components' backbone baselines. */
const COMPONENT_V_GAP = 500;
/** How far off the backbone baseline a bubble node is seeded, per BFS hop. */
const BUBBLE_Y_STEP = 70;
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
			if (assignedSegIds.has(step.segId)) continue; // guard against a path revisiting a segment
			const chain = chainById.get(step.segId);
			if (!chain) continue;
			assignedSegIds.add(step.segId);

			const numEdges = chain.nodeIds.length - 1;
			const spanLength = chainPxLength.get(step.segId) ?? numEdges * opts.unitEdgeLength;

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

			anchors.set(step.segId, { x: cursorX + spanLength / 2, y: baselineY });
			cursorX += spanLength + opts.unitEdgeLength;
		}
	});

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
		const sign = stableUnit(chain.segId) >= 0 ? 1 : -1;
		const baseX = anchor.x + stableUnit(chain.segId) * BUBBLE_Y_STEP;
		const baseY = anchor.y + sign * anchor.hops * BUBBLE_Y_STEP;

		chain.nodeIds.forEach((nodeId, i) => {
			const node = nodesById.get(nodeId)!;
			node.x = baseX + i * opts.unitEdgeLength + stableUnit(nodeId) * 6;
			node.y = baseY + stableUnit(nodeId + ':y') * 6;
			node.componentBaselineY = anchor.y;
		});
	}

	// Seed bend nodes at the midpoint of their two endpoints (now that both have
	// real positions), nudged off-axis by a deterministic jitter so the
	// simulation has a direction to push in rather than starting exactly on the
	// line it's meant to bend away from.
	for (const path of structuralLinkPaths) {
		const bend = nodesById.get(path.bendNode)!;
		const a = nodesById.get(path.fromNode)!;
		const b = nodesById.get(path.toNode)!;
		bend.x = (a.x + b.x) / 2 + stableUnit(path.bendNode) * 6;
		bend.y = (a.y + b.y) / 2 + (stableUnit(path.bendNode + ':y') >= 0 ? 1 : -1) * BUBBLE_Y_STEP * 0.4;
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
			if (absDy < minBaselineClearance) {
				const dir = dy !== 0 ? Math.sign(dy) : stableUnit(node.id) >= 0 ? 1 : -1;
				const push = (minBaselineClearance - absDy) * BASELINE_PUSH_GAIN * alpha;
				node.vy = (node.vy ?? 0) + dir * push;
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

	// Coverage heatmap: count non-reference path traversals per segment.
	// "Non-reference" excludes whichever path (if any) was picked as the
	// backbone for its component.
	const backboneSourceNames = new Set(backbones.filter((b) => b.source !== 'synthetic').map((b) => b.source));
	const pathCoverage = new Map<string, number>();
	for (const path of graph.paths) {
		if (backboneSourceNames.has(path.name)) continue;
		const seenInThisPath = new Set<string>();
		for (const step of path.steps) {
			if (seenInThisPath.has(step.segId)) continue; // count each path once per segment
			seenInThisPath.add(step.segId);
			pathCoverage.set(step.segId, (pathCoverage.get(step.segId) ?? 0) + 1);
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
