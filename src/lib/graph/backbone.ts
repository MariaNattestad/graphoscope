import type { GfaGraph, GfaPathStep } from './types';

/**
 * Picks one "backbone" path per connected component of the graph, so the
 * layout can anchor to it instead of relying on generic force-directed
 * relaxation (which has no notion of a canonical shape and makes near-
 * identical graphs come out rotated/mirrored differently).
 *
 * Preference order: an embedded GFA path/walk (P or W line) that lies in this
 * component, longest by total bp if there are several. If none exist, a
 * synthetic backbone is approximated via a weighted double-sweep (the graph
 * analogue of finding a tree's diameter): BFS/Dijkstra from an arbitrary node
 * to find the farthest node A, then from A to find the farthest node B — the
 * A-to-B path approximates the longest stretch through the component,
 * weighted by segment length so it favors long sequence, not just hop count.
 */

export interface Backbone {
	componentId: number;
	steps: GfaPathStep[];
	totalLength: number;
	source: string;
}

class MinHeap {
	private items: [number, string][] = [];

	push(item: [number, string]) {
		const items = this.items;
		items.push(item);
		let i = items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (items[parent][0] <= items[i][0]) break;
			[items[parent], items[i]] = [items[i], items[parent]];
			i = parent;
		}
	}

	pop(): [number, string] | undefined {
		const items = this.items;
		if (items.length === 0) return undefined;
		const top = items[0];
		const last = items.pop()!;
		if (items.length > 0) {
			items[0] = last;
			let i = 0;
			while (true) {
				const left = i * 2 + 1;
				const right = i * 2 + 2;
				let smallest = i;
				if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
				if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
				if (smallest === i) break;
				[items[smallest], items[i]] = [items[i], items[smallest]];
				i = smallest;
			}
		}
		return top;
	}

	get size() {
		return this.items.length;
	}
}

export function buildAdjacency(graph: GfaGraph): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	const ensure = (id: string) => {
		if (!adjacency.has(id)) adjacency.set(id, new Set());
		return adjacency.get(id)!;
	};
	for (const segId of graph.segments.keys()) ensure(segId);
	for (const link of graph.links) {
		if (!graph.segments.has(link.from) || !graph.segments.has(link.to)) continue;
		ensure(link.from).add(link.to);
		ensure(link.to).add(link.from);
	}
	return adjacency;
}

function findConnectedComponents(adjacency: Map<string, Set<string>>): string[][] {
	const visited = new Set<string>();
	const components: string[][] = [];
	// Sort for determinism: iteration order of a Map follows insertion order,
	// which already follows file order, but sort explicitly to be safe.
	const allIds = Array.from(adjacency.keys()).sort();
	for (const start of allIds) {
		if (visited.has(start)) continue;
		const component: string[] = [];
		const queue = [start];
		visited.add(start);
		while (queue.length > 0) {
			const current = queue.shift()!;
			component.push(current);
			for (const neighbor of adjacency.get(current) ?? []) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor);
					queue.push(neighbor);
				}
			}
		}
		component.sort();
		components.push(component);
	}
	return components;
}

/** Weighted single-source search (Dijkstra) returning distances and parents, weighted by the length of the node being entered. */
function weightedSweep(
	start: string,
	componentSet: Set<string>,
	adjacency: Map<string, Set<string>>,
	segmentLength: (id: string) => number
): { dist: Map<string, number>; parent: Map<string, string | null> } {
	const dist = new Map<string, number>();
	const parent = new Map<string, string | null>();
	dist.set(start, segmentLength(start));
	parent.set(start, null);

	const heap = new MinHeap();
	heap.push([dist.get(start)!, start]);

	while (heap.size > 0) {
		const [d, node] = heap.pop()!;
		if (d > (dist.get(node) ?? Infinity)) continue;
		for (const neighbor of adjacency.get(node) ?? []) {
			if (!componentSet.has(neighbor)) continue;
			const next = d + segmentLength(neighbor);
			if (next < (dist.get(neighbor) ?? Infinity)) {
				dist.set(neighbor, next);
				parent.set(neighbor, node);
				heap.push([next, neighbor]);
			}
		}
	}

	return { dist, parent };
}

function farthestNode(dist: Map<string, number>): string {
	let best = '';
	let bestDist = -Infinity;
	for (const [id, d] of dist) {
		if (d > bestDist) {
			bestDist = d;
			best = id;
		}
	}
	return best;
}

function reconstructPath(target: string, parent: Map<string, string | null>): string[] {
	const path: string[] = [];
	let current: string | null = target;
	while (current !== null) {
		path.push(current);
		current = parent.get(current) ?? null;
	}
	return path.reverse();
}

function syntheticBackbone(
	componentIds: string[],
	adjacency: Map<string, Set<string>>,
	segmentLength: (id: string) => number
): string[] {
	const componentSet = new Set(componentIds);
	const start = componentIds[0];
	const first = weightedSweep(start, componentSet, adjacency, segmentLength);
	const endA = farthestNode(first.dist);
	const second = weightedSweep(endA, componentSet, adjacency, segmentLength);
	const endB = farthestNode(second.dist);
	return reconstructPath(endB, second.parent);
}

/** Orients a path of segment ids using link data so each consecutive step's orientation is consistent with how the links connect them. */
function orientPath(segIds: string[], graph: GfaGraph): GfaPathStep[] {
	if (segIds.length === 0) return [];
	if (segIds.length === 1) return [{ segId: segIds[0], orient: '+' }];

	const linkLookup = new Map<string, { fromOrient: string; toOrient: string }[]>();
	const key = (a: string, b: string) => `${a}|${b}`;
	for (const link of graph.links) {
		if (!linkLookup.has(key(link.from, link.to))) linkLookup.set(key(link.from, link.to), []);
		linkLookup.get(key(link.from, link.to))!.push({ fromOrient: link.fromOrient, toOrient: link.toOrient });
	}

	const steps: GfaPathStep[] = [{ segId: segIds[0], orient: '+' }];
	for (let i = 1; i < segIds.length; i++) {
		const prev = segIds[i - 1];
		const curr = segIds[i];
		const prevOrient = steps[i - 1].orient;
		const forward = linkLookup.get(key(prev, curr));
		const backward = linkLookup.get(key(curr, prev));
		let orient: '+' | '-' = '+';
		if (forward && forward.length > 0) {
			const match = forward.find((l) => l.fromOrient === prevOrient) ?? forward[0];
			orient = match.toOrient as '+' | '-';
		} else if (backward && backward.length > 0) {
			const match = backward.find((l) => l.toOrient === prevOrient) ?? backward[0];
			orient = match.fromOrient === '+' ? '-' : '+';
		}
		steps.push({ segId: curr, orient });
	}
	return steps;
}

export function computeBackbones(graph: GfaGraph, referenceSample?: string): Backbone[] {
	const adjacency = buildAdjacency(graph);
	const components = findConnectedComponents(adjacency);
	const segmentLength = (id: string) => Math.max(1, graph.segments.get(id)?.length ?? 1);

	// Paths are named "sample#hap#contig" (see gfaToGraph). Prefer paths of the
	// reference sample as the backbone so the layout anchors on the real
	// reference — not merely the longest haplotype, which for an insertion allele
	// is always longer than the reference it parallels and would hijack the line.
	const isReference = (name: string) => {
		if (!referenceSample) return false;
		const hash = name.indexOf('#');
		return (hash >= 0 ? name.slice(0, hash) : name) === referenceSample;
	};

	const backbones: Backbone[] = [];

	components.forEach((componentIds, componentId) => {
		const componentSet = new Set(componentIds);

		const allCandidates = graph.paths
			.map((p) => ({ ...p, steps: p.steps.filter((s) => componentSet.has(s.segId)) }))
			.filter((p) => p.steps.length > 0);
		const refCandidates = allCandidates.filter((p) => isReference(p.name));
		const candidatePaths = refCandidates.length > 0 ? refCandidates : allCandidates;

		let steps: GfaPathStep[];
		let source: string;
		let totalLength: number;

		if (candidatePaths.length > 0) {
			let best = candidatePaths[0];
			let bestLength = -1;
			for (const p of candidatePaths) {
				const len = p.steps.reduce((sum, s) => sum + segmentLength(s.segId), 0);
				if (len > bestLength) {
					bestLength = len;
					best = p;
				}
			}
			steps = best.steps;
			source = best.name;
			totalLength = bestLength;
		} else {
			const segIds = syntheticBackbone(componentIds, adjacency, segmentLength);
			steps = orientPath(segIds, graph);
			source = 'synthetic';
			totalLength = steps.reduce((sum, s) => sum + segmentLength(s.segId), 0);
		}

		backbones.push({ componentId, steps, totalLength, source });
	});

	backbones.sort((a, b) => b.totalLength - a.totalLength);
	return backbones;
}
