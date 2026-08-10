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
// bubble" is well-defined: over the bubble's directed edges (a DAG), the most
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
	/** Most haplotypes through any of its segments (or the skip edge). */
	coverage: number;
	/** A bare reference-to-reference skip (a deletion with no alternate node). */
	isSkip: boolean;
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

/** Longest and shortest source→sink path (in bases) through a set of segments,
 * over the forward (`from`→`to`) directed edges internal to it. Each segment
 * contributes its own length. Returns null if the induced subgraph isn't a DAG
 * (shouldn't happen for Minigraph-Cactus), so the caller can fall back. */
function pathExtremes(
	comp: Set<string>,
	dout: Map<string, Set<string>>,
	len: (id: string) => number
): { shortest: number; longest: number } | null {
	const indeg = new Map<string, number>();
	const outdeg = new Map<string, number>();
	for (const u of comp) {
		indeg.set(u, indeg.get(u) ?? 0);
		outdeg.set(u, outdeg.get(u) ?? 0);
		for (const v of dout.get(u) ?? []) {
			if (comp.has(v)) {
				indeg.set(v, (indeg.get(v) ?? 0) + 1);
				outdeg.set(u, (outdeg.get(u) ?? 0) + 1);
			}
		}
	}
	// Kahn topological order.
	const ready: string[] = [...comp].filter((n) => (indeg.get(n) ?? 0) === 0);
	const ind = new Map(indeg);
	const order: string[] = [];
	for (let i = 0; i < ready.length; i++) {
		const u = ready[i];
		order.push(u);
		for (const v of dout.get(u) ?? []) {
			if (comp.has(v)) {
				ind.set(v, (ind.get(v) ?? 0) - 1);
				if (ind.get(v) === 0) ready.push(v);
			}
		}
	}
	if (order.length !== comp.size) return null; // not a DAG

	// Path length ending at each node. A source (no internal in-edge) starts a
	// path at its own length; a non-source's shortest is Infinity until relaxed.
	const dmax = new Map<string, number>();
	const dmin = new Map<string, number>();
	for (const n of comp) {
		const src = (indeg.get(n) ?? 0) === 0;
		dmax.set(n, src ? len(n) : 0);
		dmin.set(n, src ? len(n) : Infinity);
	}
	for (const u of order) {
		for (const v of dout.get(u) ?? []) {
			if (!comp.has(v)) continue;
			const lv = len(v);
			if ((dmax.get(u) ?? 0) + lv > (dmax.get(v) ?? 0)) dmax.set(v, (dmax.get(u) ?? 0) + lv);
			const du = dmin.get(u) ?? Infinity;
			if (du !== Infinity && du + lv < (dmin.get(v) ?? Infinity)) dmin.set(v, du + lv);
		}
	}
	// Extremes over sink nodes (no internal successor) — where the path exits.
	let longest = 0;
	let shortest = Infinity;
	for (const n of comp) {
		if ((outdeg.get(n) ?? 0) === 0) {
			longest = Math.max(longest, dmax.get(n) ?? 0);
			const dn = dmin.get(n) ?? Infinity;
			if (dn !== Infinity) shortest = Math.min(shortest, dn);
		}
	}
	if (shortest === Infinity) shortest = longest;
	return { shortest, longest };
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
	const cov = (id: string) => gfa.segments.get(id)?.coverage ?? 0;

	// Undirected adjacency (for components) and forward directed adjacency (for
	// path lengths). Skip edges are collected separately.
	const undir = new Map<string, Set<string>>();
	const dout = new Map<string, Set<string>>();
	const addEdge = (m: Map<string, Set<string>>, a: string, b: string) => {
		let s = m.get(a);
		if (!s) m.set(a, (s = new Set()));
		s.add(b);
	};
	for (const l of gfa.links) {
		addEdge(dout, l.from, l.to);
		addEdge(undir, l.from, l.to);
		addEdge(undir, l.to, l.from);
	}

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
		const ext = pathExtremes(comp, dout, len) ?? { shortest: totalBp, longest: totalBp };
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
			coverage,
			isSkip: false
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
			coverage: l.coverage ?? 0,
			isSkip: true
		});
	}

	bubbles.sort((x, y) => x.entryBp - y.entryBp);
	return { contig: refWalk.seqId, genomicStart: refWalk.start ?? 0, refLen, bubbles };
}
