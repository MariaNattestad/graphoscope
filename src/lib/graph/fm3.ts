import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import { hashString, seededRandom } from './prng';

/**
 * FM³ — a "Fast Multipole Multilevel Method"-style force-directed layout,
 * implemented from the published algorithm (Hachul & Jünger, 2004). This is the
 * engine behind Graphoscope's default reference-free ("Untangled") layout.
 *
 * The algorithm is plain force-directed drawing with two ideas stacked on top:
 *
 *   1. Multilevel coarsening. The graph is repeatedly collapsed into a
 *      hierarchy of ever-coarser graphs (here via *solar-system* clustering,
 *      FM³'s hallmark: a sun node, its neighbours as planets, and their
 *      neighbours as moons, collapsed to one node). The coarsest graph — a
 *      handful of nodes — is laid out first, then each finer level is seeded
 *      from its parent's positions and refined. This is what keeps the drawing
 *      globally untangled and out of the local minima a flat force sim falls
 *      into.
 *
 *   2. Multipole (Barnes–Hut) repulsion. Long-range repulsive forces are
 *      approximated with a quadtree instead of computed pairwise. d3-force's
 *      `forceManyBody` already implements exactly this, so each level's
 *      refinement borrows it directly.
 *
 * This module operates on an abstract weighted graph (node ids + weighted
 * edges) and returns a position per node. The caller (forceLayout) runs it on
 * the *segment* graph to get one centre per segment, then expands each segment
 * into its length-proportional bead chain and does a final relaxation to bend
 * the strands — the characteristic strand/"noodle" look.
 */

export interface Fm3Edge {
	a: string;
	b: string;
	/** Desired rest length between the two node centres. */
	len: number;
}

export interface Fm3Options {
	nodes: string[];
	edges: Fm3Edge[];
	/** Fixed iterations of force refinement per level (FM³ runs a constant per
	 * level; finer levels inherit a good seed so they need few). */
	iterationsPerLevel?: number;
	/** Stop coarsening once a level has at most this many nodes. */
	minCoarseNodes?: number;
	/** Safety cap on the number of hierarchy levels. */
	maxLevels?: number;
}

export interface Fm3Result {
	pos: Map<string, { x: number; y: number }>;
}

/** A node in a per-level d3 refinement sim (satisfies SimulationNodeDatum via
 * the optional index/vx/vy d3 adds). */
interface FNode {
	id: string;
	x: number;
	y: number;
	vx?: number;
	vy?: number;
	index?: number;
}

/** An edge in a per-level refinement sim. `source`/`target` start as ids and are
 * mutated to node objects by forceLink, hence the union. */
interface FLink {
	source: string | FNode;
	target: string | FNode;
	len: number;
}

interface Level {
	nodes: string[];
	adj: Map<string, { nb: string; len: number }[]>;
	/** For each node, the coarser-level cluster id it collapses into (empty on
	 * the coarsest level). */
	parentOf: Map<string, string>;
	/** For each node, its distance from the sun of its solar system (0 = sun),
	 * used to place it around the sun when un-coarsening. */
	radiusInParent: Map<string, number>;
}

function buildAdj(nodes: string[], edges: Fm3Edge[]): Map<string, { nb: string; len: number }[]> {
	const adj = new Map<string, { nb: string; len: number }[]>();
	for (const n of nodes) adj.set(n, []);
	for (const e of edges) {
		if (e.a === e.b) continue;
		adj.get(e.a)?.push({ nb: e.b, len: e.len });
		adj.get(e.b)?.push({ nb: e.a, len: e.len });
	}
	return adj;
}

/** One round of solar-system coarsening: partition the level's nodes into
 * suns + planets + moons, and build the next coarser level with one node per
 * solar system. Returns null when no further reduction happens. */
function coarsenOnce(level: Level, levelIndex: number): Level | null {
	const rng = seededRandom(hashString(`fm3:coarsen:${levelIndex}`));
	// Deterministic sun ordering: shuffle the (sorted) node list with the seeded
	// PRNG so sun choice is reproducible but not biased by id ordering.
	const order = [...level.nodes].sort();
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}

	const assigned = new Set<string>();
	// segment/level node -> its cluster id in the coarser level
	const clusterOf = new Map<string, string>();
	const radius = new Map<string, number>();
	const clusters: string[] = [];

	for (const sun of order) {
		if (assigned.has(sun)) continue;
		const clusterId = `c${levelIndex + 1}:${sun}`;
		clusters.push(clusterId);
		assigned.add(sun);
		clusterOf.set(sun, clusterId);
		radius.set(sun, 0);
		// Planets: unassigned direct neighbours of the sun.
		for (const { nb: planet, len: sunLen } of level.adj.get(sun) ?? []) {
			if (assigned.has(planet)) continue;
			assigned.add(planet);
			clusterOf.set(planet, clusterId);
			radius.set(planet, sunLen);
			// Moons: unassigned neighbours of a planet, pulled into the same system.
			for (const { nb: moon, len: planetLen } of level.adj.get(planet) ?? []) {
				if (assigned.has(moon)) continue;
				assigned.add(moon);
				clusterOf.set(moon, clusterId);
				radius.set(moon, sunLen + planetLen);
			}
		}
	}

	// No collapse possible (every node became its own cluster) → stop.
	if (clusters.length >= level.nodes.length) return null;

	// Record where each fine node lands, then build coarse edges by merging every
	// underlying edge that crosses two clusters. Desired length adds the two
	// endpoints' radii so clusters keep enough room for their members.
	for (const [node, cluster] of clusterOf) level.parentOf.set(node, cluster);
	for (const [node, r] of radius) level.radiusInParent.set(node, r);

	const merged = new Map<string, { len: number; n: number }>();
	for (const node of level.nodes) {
		const ca = clusterOf.get(node)!;
		for (const { nb, len } of level.adj.get(node) ?? []) {
			const cb = clusterOf.get(nb)!;
			if (ca === cb) continue;
			const key = ca < cb ? `${ca} ${cb}` : `${cb} ${ca}`;
			const want = len + (radius.get(node) ?? 0) + (radius.get(nb) ?? 0);
			const cur = merged.get(key);
			if (cur) {
				cur.len += want;
				cur.n++;
			} else {
				merged.set(key, { len: want, n: 1 });
			}
		}
	}

	const coarseEdges: Fm3Edge[] = [];
	for (const [key, { len, n }] of merged) {
		const [a, b] = key.split(' ');
		coarseEdges.push({ a, b, len: len / n });
	}

	return {
		nodes: clusters,
		adj: buildAdj(clusters, coarseEdges),
		parentOf: new Map(),
		radiusInParent: new Map()
	};
}

/** Force-refine one level in place, starting from the given seed positions.
 * Uses d3's Barnes–Hut `forceManyBody` for multipole-style repulsion plus
 * spring attraction along the level's edges. */
function refineLevel(level: Level, pos: Map<string, { x: number; y: number }>, iterations: number) {
	// A representative desired edge length sets the force scale for this level.
	const lens: number[] = [];
	for (const list of level.adj.values()) for (const e of list) lens.push(e.len);
	lens.sort((a, b) => a - b);
	const k = Math.max(1, lens[lens.length >> 1] ?? 60);

	const nodeObjs: FNode[] = level.nodes.map((id) => {
		const p = pos.get(id)!;
		return { id, x: p.x, y: p.y };
	});
	const links: FLink[] = [];
	const seen = new Set<string>();
	for (const node of level.nodes) {
		for (const { nb, len } of level.adj.get(node) ?? []) {
			const key = node < nb ? `${node} ${nb}` : `${nb} ${node}`;
			if (seen.has(key)) continue;
			seen.add(key);
			links.push({ source: node, target: nb, len });
		}
	}

	const sim = forceSimulation<FNode>(nodeObjs)
		.force(
			'link',
			forceLink<FNode, FLink>(links)
				.id((d) => d.id)
				.distance((l) => l.len)
				.strength(0.7)
		)
		.force('charge', forceManyBody<FNode>().strength(-k * 1.1).distanceMax(k * 8))
		.force('collide', forceCollide<FNode>(k * 0.25))
		.stop();

	for (let i = 0; i < iterations; i++) sim.tick();

	for (const n of nodeObjs) pos.set(n.id, { x: n.x, y: n.y });
}

export function runFm3(options: Fm3Options): Fm3Result {
	const iterationsPerLevel = options.iterationsPerLevel ?? 40;
	const minCoarseNodes = options.minCoarseNodes ?? 3;
	const maxLevels = options.maxLevels ?? 24;

	if (options.nodes.length === 0) return { pos: new Map() };

	// --- Build the hierarchy, finest (0) to coarsest ---
	const levels: Level[] = [
		{
			nodes: [...options.nodes],
			adj: buildAdj(options.nodes, options.edges),
			parentOf: new Map(),
			radiusInParent: new Map()
		}
	];
	while (levels.length < maxLevels) {
		const top = levels[levels.length - 1];
		if (top.nodes.length <= minCoarseNodes) break;
		const coarser = coarsenOnce(top, levels.length - 1);
		if (!coarser) break;
		levels.push(coarser);
	}

	// --- Place the coarsest level on a ring, then un-coarsen down to the finest ---
	const pos = new Map<string, { x: number; y: number }>();
	const coarsest = levels[levels.length - 1];
	// Ring radius scaled so the few coarse nodes start well separated.
	let ringLen = 0;
	let ringN = 0;
	for (const list of coarsest.adj.values())
		for (const e of list) {
			ringLen += e.len;
			ringN++;
		}
	const ringK = ringN ? ringLen / ringN : 200;
	const ringR = Math.max(ringK, (ringK * coarsest.nodes.length) / (2 * Math.PI));
	const coarseOrder = [...coarsest.nodes].sort();
	coarseOrder.forEach((id, i) => {
		const angle = (i / Math.max(1, coarseOrder.length)) * 2 * Math.PI;
		pos.set(id, { x: Math.cos(angle) * ringR, y: Math.sin(angle) * ringR });
	});
	refineLevel(coarsest, pos, iterationsPerLevel);

	for (let li = levels.length - 2; li >= 0; li--) {
		const level = levels[li];
		for (const node of level.nodes) {
			const parent = level.parentOf.get(node);
			const ppos = parent ? pos.get(parent) : undefined;
			const r = level.radiusInParent.get(node) ?? 0;
			if (!ppos) {
				// No parent (shouldn't happen below the coarsest level) — scatter.
				pos.set(node, {
					x: (seededRandom(hashString(node + ':x'))() - 0.5) * ringR,
					y: (seededRandom(hashString(node + ':y'))() - 0.5) * ringR
				});
				continue;
			}
			if (r === 0) {
				// Sun: sits at its cluster's position (tiny jitter to break ties).
				pos.set(node, {
					x: ppos.x + (seededRandom(hashString(node + ':jx'))() - 0.5) * 2,
					y: ppos.y + (seededRandom(hashString(node + ':jy'))() - 0.5) * 2
				});
			} else {
				// Planet/moon: placed around the sun at its recorded radius, at a
				// deterministic angle. Refinement then untwists the ring.
				const angle = seededRandom(hashString(node + ':ang'))() * 2 * Math.PI;
				pos.set(node, { x: ppos.x + Math.cos(angle) * r, y: ppos.y + Math.sin(angle) * r });
			}
		}
		refineLevel(level, pos, iterationsPerLevel);
	}

	// Only the finest level's positions matter to the caller.
	const finest = levels[0];
	const result = new Map<string, { x: number; y: number }>();
	for (const id of finest.nodes) result.set(id, pos.get(id) ?? { x: 0, y: 0 });
	return { pos: result };
}
