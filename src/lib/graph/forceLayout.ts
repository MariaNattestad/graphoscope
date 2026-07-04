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
 *
 * This is a single-stranded simplification: each segment is drawn once (not
 * as a forward/reverse-complement pair), which is enough for viewing topology.
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
	structuralLinkPaths: { from: string; to: string; fromNode: string; toNode: string }[];
	backbones: BackboneInfo[];
	backboneSegIds: Set<string>;
	segmentLengths: Map<string, number>;
	/** Count of non-reference (non-backbone) paths traversing each segment. */
	pathCoverage: Map<string, number>;
	maxPathCoverage: number;
}

export interface LayoutOptions {
	/** Soft budget for total number of sub-nodes across the whole graph. */
	targetTotalSubNodes?: number;
	/** Max sub-edges any single segment chain can be split into. */
	maxEdgesPerSegment?: number;
	unitEdgeLength?: number;
	iterations?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
	targetTotalSubNodes: 2500,
	maxEdgesPerSegment: 60,
	unitEdgeLength: 18,
	iterations: 350
};

/** Vertical spacing between stacked components' backbone baselines. */
const COMPONENT_V_GAP = 500;
/** How far off the backbone baseline a bubble node is seeded, per BFS hop. */
const BUBBLE_Y_STEP = 45;
/** Minimum distance (in world units) a free node is pushed to keep from the backbone line. */
const MIN_BASELINE_CLEARANCE_FACTOR = 2.2;

export function buildAndRunLayout(graph: GfaGraph, options: LayoutOptions = {}): LayoutResult {
	const opts = { ...DEFAULTS, ...options };

	let totalLength = 0;
	for (const seg of graph.segments.values()) totalLength += Math.max(1, seg.length);
	const basesPerEdge = Math.max(1, totalLength / Math.max(1, opts.targetTotalSubNodes));

	const nodesById = new Map<string, SimNode>();
	const chains: SegmentChain[] = [];
	const links: SimLink[] = [];

	for (const seg of graph.segments.values()) {
		const numEdges = Math.min(
			opts.maxEdgesPerSegment,
			Math.max(1, Math.ceil(Math.max(1, seg.length) / basesPerEdge))
		);
		const numNodes = numEdges + 1;
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
					distance: opts.unitEdgeLength,
					strength: 1,
					kind: 'chain'
				});
			}
		}
		chains.push({ segId: seg.id, nodeIds });
	}

	const chainById = new Map(chains.map((c) => [c.segId, c]));
	const structuralLinkPaths: LayoutResult['structuralLinkPaths'] = [];

	for (const link of graph.links) {
		const fromChain = chainById.get(link.from);
		const toChain = chainById.get(link.to);
		if (!fromChain || !toChain) continue;

		const fromNode =
			link.fromOrient === '+' ? fromChain.nodeIds[fromChain.nodeIds.length - 1] : fromChain.nodeIds[0];
		const toNode = link.toOrient === '+' ? toChain.nodeIds[0] : toChain.nodeIds[toChain.nodeIds.length - 1];

		if (fromNode === toNode) continue;

		links.push({
			source: fromNode,
			target: toNode,
			distance: opts.unitEdgeLength,
			strength: 0.3,
			kind: 'structural'
		});
		structuralLinkPaths.push({ from: link.from, to: link.to, fromNode, toNode });
	}

	// --- Backbone anchoring ---
	const backbones = computeBackbones(graph);
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
			const spanLength = numEdges * opts.unitEdgeLength;

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
				const push = (minBaselineClearance - absDy) * 0.2 * alpha;
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
