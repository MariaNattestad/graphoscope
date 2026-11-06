// The "Assembly graph" layout: a force-directed drawing that reads like a classic
// assembly-graph view (a reference backbone with each variant a visible bubble or
// loop), rather than a genome browser. Pair it with Fold (fold.ts) so the graph is
// down to variants big enough to see.
//
// Each step below can be switched off on its own (AssemblyOptions), so its effect
// can be compared with and without:
//
//  - collapseChains: hand the simulation one node per unbranched run, then split
//    the run's drawn polyline back into its members afterwards. Same picture, far
//    fewer beads to relax.
//  - lengthMap: how bp maps to drawn length. A linear map with a minimum puts
//    every 1–50 bp allele at the minimum, so both arms of a small bubble sit one
//    node-width apart and read as a single rope; the presets open them up.
//  - routeDeletions: split each reference→reference deletion link with a hidden
//    route node half as long as the reference it skips, so the layout makes room
//    for it like any other bubble arm. Drawn as a dashed arc along that route.
//  - anchorReference: seed the backbone along x by reference position (not
//    pinned), then rotate the result so the reference runs left to right.
//
// Everything random is seeded from node ids (prng.ts), so the same graph and
// settings always give the same drawing.

import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import type { GfaGraph, GfaLink, GfaPath, GfaSegment } from './types';
import { buildAdjacency, computeBackbones, type Backbone } from './backbone';
import { stableUnit } from './prng';
import { assembleResult, type LayoutResult, type SegmentChain, type SimNode } from './forceLayout';

export type LengthMap = 'proportional' | 'open' | 'wide' | 'compress';

export interface AssemblyOptions {
	collapseChains: boolean;
	lengthMap: LengthMap;
	routeDeletions: boolean;
	anchorReference: boolean;
}

export const DEFAULT_ASSEMBLY: AssemblyOptions = {
	collapseChains: true,
	lengthMap: 'compress',
	routeDeletions: true,
	anchorReference: true
};

export const LENGTH_MAPS: { id: LengthMap; label: string; blurb: string }[] = [
	{ id: 'proportional', label: 'Proportional', blurb: 'drawn = k × bp, with a small minimum' },
	{ id: 'open', label: 'Open bubbles', blurb: 'proportional, minimum 2.5 × the mean drawn length' },
	{ id: 'wide', label: 'Wide bubbles', blurb: 'proportional, minimum 10 × the mean drawn length' },
	{ id: 'compress', label: 'Compress', blurb: 'square-root pull of long and short nodes toward the mean' }
];

/** Rest length of a link between two nodes. */
const EDGE = 5;
/** Target spacing between consecutive points of a node's chain. */
const STEP = 20;
/** Mean drawn node length the bp scale is chosen for. */
const MEAN_DRAWN = 40;
/** Smallest total drawn length, so a tiny graph doesn't shrink to a speck. */
const MIN_TOTAL = 500;
/** Absolute floor for the compress map. */
const COMPRESS_FLOOR = 8;
/** Most edges one node's chain is split into. */
const MAX_EDGES = 24;
/** Vertical gap between the backbones of separate components. */
const COMPONENT_GAP = 400;

const START = 0;
const END = 1;

/** bp → drawn length, scaled to the graph's own mean (see LENGTH_MAPS). */
export function makeLengthMap(bps: number[], mode: LengthMap): (bp: number) => number {
	const n = Math.max(1, bps.length);
	let sum = 0;
	for (const b of bps) sum += Math.max(1, b);
	const meanBp = Math.max(1, sum / n);
	const k = MEAN_DRAWN / meanBp;
	const raw = (bp: number): number => {
		const b = Math.max(1, bp);
		switch (mode) {
			case 'open':
				return Math.max(k * b, 2.5 * MEAN_DRAWN);
			case 'wide':
				return Math.max(k * b, 10 * MEAN_DRAWN);
			case 'compress':
				return Math.max(COMPRESS_FLOOR, MEAN_DRAWN * ((Math.sqrt(b / meanBp) - 1) * 0.5 + 1));
			default:
				return Math.max(k * b, EDGE);
		}
	};
	let total = 0;
	for (const b of bps) total += raw(b);
	const scale = total > 0 && total < MIN_TOTAL ? MIN_TOTAL / total : 1;
	return (bp) => raw(bp) * scale;
}

// ---------------------------------------------------------------------------
// Part 2: unbranched chains

export interface CollapsedGraph {
	graph: GfaGraph;
	/** Run id (its first member) → members in run order (forward). */
	members: Map<string, string[]>;
}

/**
 * Merge every run A → B where A's end side has exactly one link, B's start side
 * has exactly one link, and it's the same link read forward. Links are counted
 * per side (not as in/out edges), and self-loops stay as they are.
 */
export function collapseChains(graph: GfaGraph): CollapsedGraph {
	const links = graph.links.filter((l) => graph.segments.has(l.from) && graph.segments.has(l.to));
	const sideCount = new Map<string, number>();
	const key = (id: string, side: number) => `${id}\t${side}`;
	const fromSide = (l: GfaLink) => (l.fromOrient === '+' ? END : START);
	const toSide = (l: GfaLink) => (l.toOrient === '+' ? START : END);
	for (const l of links) {
		sideCount.set(key(l.from, fromSide(l)), (sideCount.get(key(l.from, fromSide(l))) ?? 0) + 1);
		sideCount.set(key(l.to, toSide(l)), (sideCount.get(key(l.to, toSide(l))) ?? 0) + 1);
	}
	const next = new Map<string, string>();
	const prev = new Map<string, string>();
	const internalLink = new Set<number>();
	links.forEach((l, i) => {
		if (l.from === l.to) return;
		let a: string;
		let b: string;
		if (fromSide(l) === END && toSide(l) === START) [a, b] = [l.from, l.to];
		else if (fromSide(l) === START && toSide(l) === END) [a, b] = [l.to, l.from];
		else return;
		if (sideCount.get(key(a, END)) !== 1 || sideCount.get(key(b, START)) !== 1) return;
		next.set(a, b);
		prev.set(b, a);
		internalLink.add(i);
	});

	const runOf = new Map<string, string>();
	const members = new Map<string, string[]>();
	const walkRun = (start: string) => {
		const run: string[] = [];
		let cur: string | undefined = start;
		while (cur !== undefined && !runOf.has(cur)) {
			runOf.set(cur, start);
			run.push(cur);
			cur = next.get(cur);
		}
		members.set(start, run);
	};
	for (const id of graph.segments.keys()) if (!prev.has(id)) walkRun(id);
	// What's left is a closed unbranched cycle: start it at its smallest id.
	for (const id of [...graph.segments.keys()].sort()) if (!runOf.has(id)) walkRun(id);

	const segments = new Map<string, GfaSegment>();
	for (const [runId, run] of members) {
		if (run.length === 1) {
			segments.set(runId, graph.segments.get(runId)!);
			continue;
		}
		let length = 0;
		let coverage: number | undefined;
		for (const m of run) {
			const s = graph.segments.get(m)!;
			length += s.length;
			if (s.coverage !== undefined) coverage = Math.max(coverage ?? 0, s.coverage);
		}
		segments.set(runId, { id: runId, length, tags: {}, coverage });
	}
	// A cycle's closing link (last → first) isn't internal; every other link sits
	// on a run's outer sides, which map onto the run's own START/END unchanged.
	const runLinks: GfaLink[] = [];
	links.forEach((l, i) => {
		if (internalLink.has(i) && runOf.get(l.from) === runOf.get(l.to)) {
			const run = members.get(runOf.get(l.from)!)!;
			const a = fromSide(l) === END ? l.from : l.to;
			if (run.indexOf(a) !== run.length - 1) return;
		}
		runLinks.push({ ...l, from: runOf.get(l.from)!, to: runOf.get(l.to)! });
	});
	const paths: GfaPath[] = graph.paths.map((p) => {
		const steps: GfaPath['steps'] = [];
		for (const st of p.steps) {
			const id = runOf.get(st.id);
			if (id === undefined) continue;
			const last = steps[steps.length - 1];
			if (last && last.id === id && last.orient === st.orient && members.get(id)!.length > 1) continue;
			steps.push(id === st.id ? st : { id, orient: st.orient });
		}
		return { name: p.name, steps };
	});
	return { graph: { ...graph, segments, links: runLinks, paths }, members };
}

// ---------------------------------------------------------------------------
// The layout

export function buildAssemblyLayout(
	graph: GfaGraph,
	options: { referenceSample?: string; assembly?: Partial<AssemblyOptions>; iterations?: number } = {}
): LayoutResult {
	const opts = { ...DEFAULT_ASSEMBLY, ...options.assembly };
	const collapsed = opts.collapseChains ? collapseChains(graph) : null;
	const g = collapsed ? collapsed.graph : graph;

	const bps = [...g.segments.values()].map((s) => s.length);
	const drawnOf = makeLengthMap(bps, opts.lengthMap);
	const drawn = new Map<string, number>();
	for (const s of g.segments.values()) drawn.set(s.id, drawnOf(s.length));

	const nodesById = new Map<string, SimNode>();
	const chains: SegmentChain[] = [];
	const chainById = new Map<string, SegmentChain>();
	const simLinks: { source: string; target: string; distance: number; strength: number }[] = [];
	const newNode = (id: string, segId: string, posIndex: number, isChainEnd: boolean): SimNode => {
		const n: SimNode = { id, segId, posIndex, isChainEnd, x: 0, y: 0, componentBaselineY: 0 };
		nodesById.set(id, n);
		return n;
	};
	const addChain = (prefix: string, segId: string, length: number): string[] => {
		const edges = Math.min(MAX_EDGES, Math.max(1, Math.round(length / STEP)));
		const ids: string[] = [];
		for (let i = 0; i <= edges; i++) {
			const id = `${prefix}::${i}`;
			newNode(id, segId, i, i === 0 || i === edges);
			if (i > 0) simLinks.push({ source: ids[i - 1], target: id, distance: length / edges, strength: 1 });
			ids.push(id);
		}
		return ids;
	};
	for (const s of g.segments.values()) {
		const chain = { segId: s.id, nodeIds: addChain(s.id, s.id, drawn.get(s.id)!) };
		chains.push(chain);
		chainById.set(s.id, chain);
	}

	// Reference coordinates along each component's backbone, in bp and drawn units.
	const backbones = computeBackbones(g, options.referenceSample);
	const bb = new Map<string, { ci: number; orient: '+' | '-'; x0: number; x1: number; bp0: number; bp1: number }>();
	backbones.forEach((b, ci) => {
		let x = 0;
		let bp = 0;
		for (const st of b.steps) {
			if (bb.has(st.id) || !g.segments.has(st.id)) continue;
			const d = drawn.get(st.id)!;
			const len = g.segments.get(st.id)!.length;
			bb.set(st.id, { ci, orient: st.orient, x0: x, x1: x + d, bp0: bp, bp1: bp + len });
			x += d + EDGE;
			bp += len;
		}
	});
	const backboneSet = new Set(bb.keys());
	/** Where a side of a backbone segment sits on its reference, in bp and drawn x. */
	const sideAt = (id: string, side: number) => {
		const b = bb.get(id)!;
		const atStart = (side === START) === (b.orient === '+');
		return { bp: atStart ? b.bp0 : b.bp1, x: atStart ? b.x0 : b.x1, ci: b.ci };
	};
	const endNode = (id: string, side: number) => {
		const c = chainById.get(id)!.nodeIds;
		return side === START ? c[0] : c[c.length - 1];
	};

	const structuralLinkPaths: LayoutResult['structuralLinkPaths'] = [];
	const routes: NonNullable<LayoutResult['assembly']>['routes'] = [];
	for (const l of g.links) {
		if (!chainById.has(l.from) || !chainById.has(l.to)) continue;
		const fs = l.fromOrient === '+' ? END : START;
		const ts = l.toOrient === '+' ? START : END;
		const fromNode = endNode(l.from, fs);
		const toNode = endNode(l.to, ts);
		if (fromNode === toNode) continue;
		if (opts.routeDeletions && bb.has(l.from) && bb.has(l.to)) {
			const a = sideAt(l.from, fs);
			const b = sideAt(l.to, ts);
			const skipBp = Math.abs(a.bp - b.bp);
			if (a.ci === b.ci && skipBp > 0) {
				const r = routes.length;
				const nodeIds = addChain(`route::${r}`, ROUTE_SEG_ID, Math.max(EDGE, Math.abs(a.x - b.x) / 2));
				simLinks.push(
					{ source: fromNode, target: nodeIds[0], distance: EDGE, strength: 1 },
					{ source: nodeIds[nodeIds.length - 1], target: toNode, distance: EDGE, strength: 1 }
				);
				routes.push({ from: l.from, to: l.to, fromNode, toNode, nodeIds, skipBp });
				continue;
			}
		}
		simLinks.push({ source: fromNode, target: toNode, distance: EDGE, strength: 1 });
		structuralLinkPaths.push({ from: l.from, to: l.to, fromNode, toNode, bendNode: '' });
	}

	if (opts.anchorReference) seedAlongReference(g, chains, chainById, nodesById, bb, routes, drawn);
	else seedScattered(chains, nodesById, routes, drawn);

	const nodeArray = [...nodesById.values()];
	const n = nodeArray.length;
	const iterations = options.iterations ?? (n < 3000 ? 300 : n < 10000 ? 150 : 60);
	const simulation = forceSimulation(nodeArray)
		.alphaDecay(1 - Math.pow(0.001, 1 / iterations))
		.force(
			'link',
			forceLink<SimNode, (typeof simLinks)[number]>(simLinks)
				.id((d) => d.id)
				.distance((d) => d.distance)
				.strength((d) => d.strength)
		)
		.force('charge', forceManyBody<SimNode>().strength(-30).distanceMax(250))
		.force('collide', forceCollide<SimNode>(4))
		.stop();
	for (let i = 0; i < iterations; i++) simulation.tick();

	if (opts.anchorReference) rotateReferenceLeftToRight(backbones, chainById, nodesById);

	let result = assembleResult(g, backbones, backboneSet, nodesById, chains, structuralLinkPaths);
	const refFrac = new Map<string, [number, number]>();
	for (const [id, b] of bb) {
		const total = Math.max(1, backbones[b.ci].totalLength);
		refFrac.set(id, [b.bp0 / total, b.bp1 / total]);
	}
	result.assembly = { refFrac, routes, runs: [] };
	if (collapsed) result = splitRuns(result, graph, backbones, collapsed.members, drawnOf);
	return result;
}

/** Sentinel segId for route nodes: never a strand, never hit-tested. */
export const ROUTE_SEG_ID = '__route__';

/** Part 5: backbone along x by reference position; everything else near where it
 * attaches, one hop further out per BFS step. Seeds only — nothing is pinned. */
function seedAlongReference(
	g: GfaGraph,
	chains: SegmentChain[],
	chainById: Map<string, SegmentChain>,
	nodesById: Map<string, SimNode>,
	bb: Map<string, { ci: number; orient: '+' | '-'; x0: number; x1: number }>,
	routes: NonNullable<LayoutResult['assembly']>['routes'],
	drawn: Map<string, number>
) {
	const anchor = new Map<string, { x: number; y: number; hops: number }>();
	const queue: string[] = [];
	for (const [id, b] of bb) {
		const y = b.ci * COMPONENT_GAP;
		const ids = chainById.get(id)!.nodeIds;
		ids.forEach((nid, i) => {
			const t = ids.length === 1 ? 0 : i / (ids.length - 1);
			const node = nodesById.get(nid)!;
			node.x = b.orient === '+' ? b.x0 + t * (b.x1 - b.x0) : b.x1 - t * (b.x1 - b.x0);
			node.y = y + stableUnit(nid + ':y') * 2;
			node.componentBaselineY = y;
		});
		anchor.set(id, { x: (b.x0 + b.x1) / 2, y, hops: 0 });
		queue.push(id);
	}
	const adjacency = buildAdjacency(g);
	for (let head = 0; head < queue.length; head++) {
		const cur = anchor.get(queue[head])!;
		for (const nb of [...(adjacency.get(queue[head]) ?? [])].sort()) {
			if (anchor.has(nb)) continue;
			anchor.set(nb, { x: cur.x, y: cur.y, hops: cur.hops + 1 });
			queue.push(nb);
		}
	}
	for (const chain of chains) {
		if (bb.has(chain.segId)) continue;
		const a = anchor.get(chain.segId) ?? { x: 0, y: 0, hops: 1 };
		const side = stableUnit(chain.segId + ':side') >= 0 ? 1 : -1;
		const d = drawn.get(chain.segId)!;
		const cy = a.y - side * a.hops * STEP * 1.5;
		const cx = a.x + stableUnit(chain.segId) * STEP * 2;
		chain.nodeIds.forEach((nid, i) => {
			const t = chain.nodeIds.length === 1 ? 0 : i / (chain.nodeIds.length - 1) - 0.5;
			const node = nodesById.get(nid)!;
			node.x = cx + t * d + stableUnit(nid) * 2;
			node.y = cy + stableUnit(nid + ':y') * 2;
			node.componentBaselineY = a.y;
		});
	}
	// Route nodes: an arc over the reference they skip.
	for (const r of routes) {
		const a = nodesById.get(r.fromNode)!;
		const b = nodesById.get(r.toNode)!;
		const span = Math.hypot(b.x - a.x, b.y - a.y);
		r.nodeIds.forEach((nid, i) => {
			const t = (i + 1) / (r.nodeIds.length + 1);
			const node = nodesById.get(nid)!;
			node.x = a.x + t * (b.x - a.x);
			node.y = a.y + t * (b.y - a.y) - Math.sin(Math.PI * t) * span * 0.25;
		});
	}
}

/** Without Part 5: a seeded scatter, so the drawing finds its own orientation. */
function seedScattered(
	chains: SegmentChain[],
	nodesById: Map<string, SimNode>,
	routes: NonNullable<LayoutResult['assembly']>['routes'],
	drawn: Map<string, number>
) {
	let total = 0;
	for (const d of drawn.values()) total += d;
	const side = Math.sqrt(total * STEP * 3);
	for (const chain of chains) {
		const cx = stableUnit(chain.segId + ':cx') * side;
		const cy = stableUnit(chain.segId + ':cy') * side;
		const ang = stableUnit(chain.segId + ':ang') * 2 * Math.PI;
		const d = drawn.get(chain.segId)!;
		chain.nodeIds.forEach((nid, i) => {
			const t = chain.nodeIds.length === 1 ? 0 : i / (chain.nodeIds.length - 1) - 0.5;
			const node = nodesById.get(nid)!;
			node.x = cx + Math.cos(ang) * t * d;
			node.y = cy + Math.sin(ang) * t * d;
		});
	}
	for (const r of routes) {
		const a = nodesById.get(r.fromNode)!;
		const b = nodesById.get(r.toNode)!;
		r.nodeIds.forEach((nid, i) => {
			const t = (i + 1) / (r.nodeIds.length + 1);
			const node = nodesById.get(nid)!;
			node.x = a.x + t * (b.x - a.x) + stableUnit(nid) * STEP;
			node.y = a.y + t * (b.y - a.y) + stableUnit(nid + ':y') * STEP;
		});
	}
}

/** Rotate the whole drawing so the main backbone's start→end runs left to right. */
export function rotateReferenceLeftToRight(
	backbones: Backbone[],
	chainById: Map<string, SegmentChain>,
	nodesById: Map<string, SimNode>
) {
	const steps = backbones[0]?.steps.filter((s) => chainById.has(s.id)) ?? [];
	if (steps.length === 0) return;
	const pointAt = (st: { id: string; orient: '+' | '-' }, entry: boolean) => {
		const ids = chainById.get(st.id)!.nodeIds;
		const first = (st.orient === '+') === entry;
		return nodesById.get(first ? ids[0] : ids[ids.length - 1])!;
	};
	const a = pointAt(steps[0], true);
	const b = pointAt(steps[steps.length - 1], false);
	const angle = Math.atan2(b.y - a.y, b.x - a.x);
	if (!Number.isFinite(angle) || (a.x === b.x && a.y === b.y)) return;
	const cos = Math.cos(-angle);
	const sin = Math.sin(-angle);
	for (const node of nodesById.values()) {
		const x = node.x;
		const y = node.y;
		node.x = x * cos - y * sin;
		node.y = x * sin + y * cos;
	}
}

/** Part 2, after layout: split each run's polyline back into its members, in
 * proportion to their drawn lengths, so hit-testing, labels and colour work per
 * original node again. */
function splitRuns(
	res: LayoutResult,
	original: GfaGraph,
	backbones: Backbone[],
	members: Map<string, string[]>,
	drawnOf: (bp: number) => number
): LayoutResult {
	const nodesById = res.nodesById;
	const chains: SegmentChain[] = [];
	const endRemap = new Map<string, { seg: string; node: string }>();
	const backboneSet = new Set<string>();
	const refFrac = new Map<string, [number, number]>();
	const runs: { members: string[]; bp: number }[] = [];
	// The links *inside* a run were folded away by collapseChains, so the simulation
	// only saw the run's outer ends. Splitting the run back into members leaves each
	// interior member end with no link attached, which reads as a loose end — and a
	// loose end is exactly what the canvas marks as an off-locus exit. Re-emit those
	// joins (zero-length, member end → next member's start) so every split end that
	// was joined in the original graph is still joined in the layout.
	const internalLinks: LayoutResult['structuralLinkPaths'] = [];

	for (const chain of res.chains) {
		const run = members.get(chain.segId);
		const isBackbone = res.backboneSegIds.has(chain.segId);
		if (!run || run.length === 1) {
			chains.push(chain);
			if (isBackbone) backboneSet.add(chain.segId);
			const f = res.assembly!.refFrac.get(chain.segId);
			if (f) refFrac.set(chain.segId, f);
			continue;
		}
		const pts = chain.nodeIds.map((id) => nodesById.get(id)!);
		const cum = [0];
		for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
		const L = cum[cum.length - 1];
		const at = (s: number) => {
			let i = 1;
			while (i < cum.length - 1 && cum[i] < s) i++;
			const seg = cum[i] - cum[i - 1] || 1;
			const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
			return { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
		};
		const lens = run.map((m) => original.segments.get(m)!.length);
		const ds = lens.map((b) => drawnOf(b));
		const dTotal = ds.reduce((a, b) => a + b, 0) || 1;
		const bpTotal = lens.reduce((a, b) => a + b, 0) || 1;
		const frac = res.assembly!.refFrac.get(chain.segId);
		const base = pts[0];
		for (const id of chain.nodeIds) nodesById.delete(id);

		let s0 = 0;
		let bpAcc = 0;
		let prevEnd: string | null = null;
		run.forEach((m, mi) => {
			const s1 = mi === run.length - 1 ? L : s0 + (ds[mi] / dTotal) * L;
			const mpts = [at(s0)];
			for (let i = 1; i < cum.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) mpts.push(pts[i]);
			mpts.push(at(s1));
			const nodeIds = mpts.map((p, j) => {
				const id = `${m}::${j}`;
				nodesById.set(id, {
					id,
					segId: m,
					posIndex: j,
					isChainEnd: j === 0 || j === mpts.length - 1,
					x: p.x,
					y: p.y,
					componentBaselineY: base.componentBaselineY
				});
				return id;
			});
			chains.push({ segId: m, nodeIds });
			if (prevEnd !== null)
				internalLinks.push({ from: run[mi - 1], to: m, fromNode: prevEnd, toNode: nodeIds[0], bendNode: '' });
			prevEnd = nodeIds[nodeIds.length - 1];
			if (isBackbone) backboneSet.add(m);
			if (frac) {
				const f0 = frac[0] + ((frac[1] - frac[0]) * bpAcc) / bpTotal;
				const f1 = frac[0] + ((frac[1] - frac[0]) * (bpAcc + lens[mi])) / bpTotal;
				refFrac.set(m, [f0, f1]);
			}
			bpAcc += lens[mi];
			if (mi === 0) endRemap.set(chain.nodeIds[0], { seg: m, node: nodeIds[0] });
			if (mi === run.length - 1)
				endRemap.set(chain.nodeIds[chain.nodeIds.length - 1], { seg: m, node: nodeIds[nodeIds.length - 1] });
			s0 = s1;
		});
		runs.push({ members: run, bp: bpTotal });
	}

	const fixEnd = (seg: string, node: string) => endRemap.get(node) ?? { seg, node };
	const structuralLinkPaths = res.structuralLinkPaths.map((p) => {
		const a = fixEnd(p.from, p.fromNode);
		const b = fixEnd(p.to, p.toNode);
		return { ...p, from: a.seg, fromNode: a.node, to: b.seg, toNode: b.node };
	});
	structuralLinkPaths.push(...internalLinks);
	const routes = res.assembly!.routes.map((r) => {
		const a = fixEnd(r.from, r.fromNode);
		const b = fixEnd(r.to, r.toNode);
		return { ...r, from: a.seg, fromNode: a.node, to: b.seg, toNode: b.node };
	});
	const out = assembleResult(original, backbones, backboneSet, nodesById, chains, structuralLinkPaths);
	out.assembly = { refFrac, routes, runs };
	return out;
}
