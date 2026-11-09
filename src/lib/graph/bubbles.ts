// Bubble cataloguing for the reduced graph.
//
// A "bubble" is anything that departs from the reference and survives
// simplification: a connected component of non-reference segments (an alternate
// structure hanging off the reference), or a skip edge that jumps over reference
// (a deletion with no alternate node). Everything here is computed from the
// *reduced graph the viewer draws* — the same segments, links, and reference
// walk — so a bubble is anchored purely to the reference coordinates where it
// attaches, and can't drift from where the reference is cut.
//
// Minigraph-Cactus graphs are acyclic, so "longest/shortest path through the
// bubble" is well-defined: over the bubble's oriented segments (a DAG), the most
// and fewest alternate bases any route takes between its reference attachments.
// We deliberately do not classify these as insertions or deletions — we just
// catalogue the two path lengths and let the reader interpret them against the
// reference span the bubble covers.

import type { Gfa } from '../gfa';

export interface Bubble {
	/** Reference-path bp of the leftmost and rightmost points the bubble attaches
	 * to the reference (its "cut sites"). Equal when it attaches at a single point
	 * (a pure insertion/tip). Add `genomicStart` for an absolute coordinate. */
	entryBp: number;
	exitBp: number;
	/** Reference bases the bubble spans (`exitBp - entryBp`). */
	refSpan: number;
	/** Fewest and most alternate bases any path takes through the bubble. */
	shortest: number;
	longest: number;
	/** Non-reference segments in the bubble (0 for a bare skip edge). */
	nodeCount: number;
	/** The bubble's non-reference segment ids — the same ids the viewer draws, so a
	 * node can be mapped back to the bubble it belongs to (empty for a skip edge). */
	nodeIds: string[];
	/** Most walks through any of its segments (or the skip edge). */
	coverage: number;
	/** A bare reference-to-reference skip (a deletion with no alternate node). */
	isSkip: boolean;
	/** For a skip, the reference segment ids its link connects (so the viewer can
	 * match it to the structural link it draws). Empty for a node bubble. */
	linkFrom: string;
	linkTo: string;
}

export interface BubbleModel {
	contig: string;
	/** Genomic coordinate of the reference-path start; add to entry/exit bp. */
	genomicStart: number;
	/** Total reference-path length in the subgraph, bp. */
	refLen: number;
	bubbles: Bubble[];
}

/** The reference bp a link touches on a reference node, or null if the link
 * isn't between a reference and a non-reference node. A '+' segment is entered
 * at its start and left from its end; a '-' segment is the mirror. */
function refTouchBp(
	l: { from: string; fromOrient: string; to: string; toOrient: string },
	refCoord: Map<string, { start: number; end: number }>
): number | null {
	const fromR = refCoord.get(l.from);
	const toR = refCoord.get(l.to);
	if (fromR && !toR) return l.fromOrient === '+' ? fromR.end : fromR.start; // leaves `from`
	if (toR && !fromR) return l.toOrient === '+' ? toR.start : toR.end; // enters `to`
	return null;
}

type Oriented = { from: string; fromOrient: string; to: string; toOrient: string };
const flip = (o: string) => (o === '+' ? '-' : '+');

/** Longest and shortest path (in bases) through a set of segments, from where a
 * path enters it to where one leaves. Each segment contributes its own length.
 *
 * Paths are traced over *oriented* segments (`id+` / `id-`), with every link read
 * both ways: `a+ → b-` is the same edge as `b+ → a-`, and a file may spell an edge
 * either way — `-/-` links and segments stored on the opposite strand are common in
 * Minigraph-Cactus output. Reading links as plain `from → to` arrows instead makes
 * the answer depend on that spelling. A path starts where it enters from the
 * reference (or at an oriented segment nothing leads into) and ends where it leaves
 * to the reference (or where nothing leads on). Each path is found twice, once per
 * direction of reading, with the same length. Returns null if the oriented graph
 * has a cycle, so the caller can fall back. */
function pathExtremes(
	comp: Set<string>,
	links: Oriented[],
	isRef: (id: string) => boolean,
	len: (id: string) => number
): { shortest: number; longest: number } | null {
	const key = (id: string, o: string) => `${id}${o}`;
	const next = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	const fromRef = new Set<string>();
	const toRef = new Set<string>();
	for (const id of comp) for (const o of ['+', '-']) indeg.set(key(id, o), 0);
	for (const l of links) {
		const a = comp.has(l.from);
		const b = comp.has(l.to);
		if (a && b) {
			for (const [u, v] of [
				[key(l.from, l.fromOrient), key(l.to, l.toOrient)],
				[key(l.to, flip(l.toOrient)), key(l.from, flip(l.fromOrient))]
			]) {
				(next.get(u) ?? next.set(u, []).get(u)!).push(v);
				indeg.set(v, indeg.get(v)! + 1);
			}
		} else if (a && isRef(l.to)) {
			toRef.add(key(l.from, l.fromOrient));
			fromRef.add(key(l.from, flip(l.fromOrient)));
		} else if (b && isRef(l.from)) {
			fromRef.add(key(l.to, l.toOrient));
			toRef.add(key(l.to, flip(l.toOrient)));
		}
	}
	// Kahn topological order over the oriented segments.
	const ind = new Map(indeg);
	const order = [...indeg.keys()].filter((n) => ind.get(n) === 0);
	for (let i = 0; i < order.length; i++)
		for (const v of next.get(order[i]) ?? []) {
			ind.set(v, ind.get(v)! - 1);
			if (ind.get(v) === 0) order.push(v);
		}
	if (order.length !== indeg.size) return null; // not a DAG

	// Path length ending at each oriented segment, from the starts.
	const lenOf = (n: string) => len(n.slice(0, -1));
	const dmax = new Map<string, number>();
	const dmin = new Map<string, number>();
	for (const n of order) {
		if (fromRef.has(n) || indeg.get(n) === 0) {
			dmax.set(n, lenOf(n));
			dmin.set(n, lenOf(n));
		}
	}
	for (const u of order) {
		const du = dmax.get(u);
		if (du === undefined) continue;
		for (const v of next.get(u) ?? []) {
			dmax.set(v, Math.max(dmax.get(v) ?? -Infinity, du + lenOf(v)));
			dmin.set(v, Math.min(dmin.get(v) ?? Infinity, dmin.get(u)! + lenOf(v)));
		}
	}
	let longest = -Infinity;
	let shortest = Infinity;
	for (const n of order) {
		if (!dmax.has(n) || !(toRef.has(n) || !(next.get(n)?.length ?? 0))) continue;
		longest = Math.max(longest, dmax.get(n)!);
		shortest = Math.min(shortest, dmin.get(n)!);
	}
	return longest === -Infinity ? null : { shortest, longest };
}

export function computeBubbles(gfa: Gfa, referenceSample: string): BubbleModel | null {
	const refWalk = gfa.walks.find((w) => w.sample === referenceSample) ?? gfa.walks[0];
	if (!refWalk) return null;

	// Reference node -> [start, end) bp along the reference path.
	const refCoord = new Map<string, { start: number; end: number }>();
	let off = 0;
	for (const s of refWalk.steps) {
		const len = gfa.segments.get(s.id)?.length ?? 0;
		if (!refCoord.has(s.id)) refCoord.set(s.id, { start: off, end: off + len });
		off += len;
	}
	const refLen = Math.max(1, off);
	const len = (id: string) => gfa.segments.get(id)?.length ?? 0;

	// Walk-coverage fallback. The reduced graph tags every segment and link with a
	// walk count (`coverage` / `WC`); the full/unsimplified graph does not — but it
	// still carries the walks, so we count them ourselves. Built lazily (only when a
	// tag is missing, i.e. the full graph) and once, so a deletion still reports its
	// real walk count instead of a misleading 0.
	const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
	let walkCov: { node: Map<string, number>; edge: Map<string, number> } | null = null;
	const ensureWalkCov = () => {
		if (walkCov) return walkCov;
		const node = new Map<string, number>();
		const edge = new Map<string, number>();
		for (const w of gfa.walks) {
			if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
			const steps = w.steps;
			const seenNode = new Set<string>();
			for (let i = 0; i < steps.length; i++) {
				const id = steps[i].id;
				if (!seenNode.has(id)) {
					seenNode.add(id);
					node.set(id, (node.get(id) ?? 0) + 1);
				}
				if (i + 1 < steps.length) {
					const k = edgeKey(id, steps[i + 1].id);
					edge.set(k, (edge.get(k) ?? 0) + 1);
				}
			}
		}
		return (walkCov = { node, edge });
	};
	const cov = (id: string) => gfa.segments.get(id)?.coverage ?? ensureWalkCov().node.get(id) ?? 0;
	const edgeCov = (a: string, b: string, tagged?: number) =>
		tagged ?? ensureWalkCov().edge.get(edgeKey(a, b)) ?? 0;

	// Undirected adjacency, for components. Skip edges are collected separately.
	const undir = new Map<string, Set<string>>();
	const addEdge = (a: string, b: string) => {
		let s = undir.get(a);
		if (!s) undir.set(a, (s = new Set()));
		s.add(b);
	};
	for (const l of gfa.links) {
		addEdge(l.from, l.to);
		addEdge(l.to, l.from);
	}

	// Links touching each segment, so a bubble's path lengths read only its own.
	const linksOf = new Map<string, Oriented[]>();
	for (const l of gfa.links)
		for (const id of new Set([l.from, l.to])) (linksOf.get(id) ?? linksOf.set(id, []).get(id)!).push(l);

	// Attachment bp of every reference↔non-reference link, keyed by the non-ref
	// endpoint, so each bubble can read where its members touch the reference.
	const attachBp = new Map<string, number[]>();
	for (const l of gfa.links) {
		const bp = refTouchBp(l, refCoord);
		if (bp == null) continue;
		const nonRef = refCoord.has(l.from) ? l.to : l.from;
		(attachBp.get(nonRef) ?? attachBp.set(nonRef, []).get(nonRef)!).push(bp);
	}

	const bubbles: Bubble[] = [];

	// --- Non-reference components -------------------------------------------
	const seen = new Set<string>();
	for (const id of gfa.segments.keys()) {
		if (refCoord.has(id) || seen.has(id)) continue;
		const comp = new Set<string>();
		const attaches: number[] = [];
		const stack = [id];
		seen.add(id);
		while (stack.length) {
			const u = stack.pop()!;
			comp.add(u);
			for (const bp of attachBp.get(u) ?? []) attaches.push(bp);
			for (const v of undir.get(u) ?? []) {
				if (!refCoord.has(v) && !seen.has(v)) {
					seen.add(v);
					stack.push(v);
				}
			}
		}
		if (attaches.length === 0) continue; // floats free of the reference
		const entryBp = Math.min(...attaches);
		const exitBp = Math.max(...attaches);
		const totalBp = [...comp].reduce((a, n) => a + len(n), 0);
		const compLinks = [...new Set([...comp].flatMap((n) => linksOf.get(n) ?? []))];
		const ext = pathExtremes(comp, compLinks, (n) => refCoord.has(n), len) ?? {
			shortest: totalBp,
			longest: totalBp
		};
		let coverage = 0;
		let nodeCount = 0;
		for (const n of comp) {
			coverage = Math.max(coverage, cov(n));
			nodeCount++;
		}
		bubbles.push({
			entryBp,
			exitBp,
			refSpan: exitBp - entryBp,
			shortest: ext.shortest,
			longest: ext.longest,
			nodeCount,
			nodeIds: [...comp],
			coverage,
			isSkip: false,
			linkFrom: '',
			linkTo: ''
		});
	}

	// --- Skip edges (reference→reference jumps: a deletion with no alt node) --
	const seenSkip = new Set<string>();
	for (const l of gfa.links) {
		const a = refCoord.get(l.from);
		const b = refCoord.get(l.to);
		if (!a || !b) continue;
		const [lo, hi] = a.start <= b.start ? [a, b] : [b, a];
		const gap = hi.start - lo.end;
		if (gap <= 0) continue; // adjacent reference nodes, not a jump
		const key = `${Math.min(a.end, b.end)}>${Math.max(a.start, b.start)}`;
		if (seenSkip.has(key)) continue;
		seenSkip.add(key);
		bubbles.push({
			entryBp: lo.end,
			exitBp: hi.start,
			refSpan: gap, // the reference it jumps over (shown as the extent)
			shortest: 0, // the alternate path (the skip) takes no bases…
			longest: 0, // …so both path lengths are 0 on the value axis
			nodeCount: 0,
			nodeIds: [],
			coverage: edgeCov(l.from, l.to, l.coverage),
			isSkip: true,
			linkFrom: l.from,
			linkTo: l.to
		});
	}

	bubbles.sort((x, y) => x.entryBp - y.entryBp);
	return { contig: refWalk.seqId, genomicStart: refWalk.start ?? 0, refLen, bubbles };
}
