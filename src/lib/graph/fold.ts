// Allele-level folding: shrink a pangenome subgraph to the variants big enough to
// see, so a force-directed drawing reads like a classic assembly-graph view — a
// clear reference backbone with each meaningful variant as a visible bubble, and
// no clutter of 1 bp nodes or small stubs hanging off larger bubbles.
//
// Earlier passes removed small nodes one node (or one bubble) at a time, which
// left stubs attached to big bubbles: a 3 kb insertion cut into 40 segments by
// nested SNPs kept every SNP arm. Folding decides per *allele* instead — the
// contiguous stretch of sequence one assembly contributed — and keeps only the
// minimal connection from each kept allele back to the reference:
//
//   A. group segments into alleles (contiguous on their home sequence);
//   B. size each allele (its own bp, or the reference it replaces if larger);
//   C. keep the backbone + every allele ≥ threshold (or leaving the locus), plus
//      the shortest route (multi-source Dijkstra from the backbone) from each kept
//      allele's two ends back to the backbone, closing off every side of a route
//      segment the same way; drop everything else;
//   D. drop small deletion links (skips < threshold), keeping the shortest ones
//      where they're needed to keep the graph in one piece, and any that is the
//      last link on a side — a side with no link reads as an off-locus exit;
//   E. merge runs of kept segments of the same allele that nothing branches off.
//
// The output is again a `Gfa`, with walks rerouted through what's kept, so it can
// be folded again: folding at t1 then t2 ≈ folding once at t2.

import type { Gfa, Link, Orient, Segment, Step, Walk } from '../gfa';

/** Where a segment lives on the assembly that contributed it. */
export interface Home {
	/** Home sequence name (reference contig, or one haplotype walk). */
	seq: string;
	/** Start coordinate on that sequence. */
	start: number;
	/** 0 for the reference, ≥1 for any other assembly. */
	rank: number;
	/** Orientation the home sequence reads this segment in. */
	orient: Orient;
}

export interface FoldStats {
	segmentsBefore: number;
	segmentsAfter: number;
	linksBefore: number;
	linksAfter: number;
	/** Non-backbone allele groups found (Step A). */
	alleles: number;
	/** Of those, the ones at least `threshold` in size (Step B/C). */
	keptAlleles: number;
	/** Small segments kept only as the route from a kept allele to the backbone. */
	routeSegments: number;
	/** Small deletion links dropped (Step D), net of those restored. */
	droppedSkips: number;
	/** Skips kept anyway: to reconnect the graph, or as the last link on a side. */
	restoredSkips: number;
	/** Segments absorbed into a neighbour by Step E. */
	merged: number;
}

export interface FoldResult {
	gfa: Gfa;
	/** Home of every segment in the output (merged runs take their first member's). */
	homes: Map<string, Home>;
	/** Original segment id → the output segment standing for it (absent = dropped). */
	repOf: Map<string, string>;
	stats: FoldStats;
	/** False when the graph has no reference to fold toward (returned unchanged). */
	applied: boolean;
}

export interface FoldOptions {
	/** Sample whose walk(s) are the reference. Falls back to the first walk. */
	referenceSample?: string;
	/** Precomputed homes (e.g. from a previous fold), skipping home inference. */
	homes?: Map<string, Home>;
}

// ---------------------------------------------------------------------------
// Sides. Every segment has a start side and an end side; a link attaches to one
// side of each of its segments, decided by the strands: `L a + b -` leaves the
// END of a and arrives at the END of b.

const START = 0;
const END = 1;
type Side = typeof START | typeof END;

function fromSide(l: Link): Side {
	return l.fromOrient === '+' ? END : START;
}
function toSide(l: Link): Side {
	return l.toOrient === '+' ? START : END;
}
/** The side a home sequence enters a segment by (its home "start"). */
function entrySide(h: Home): Side {
	return h.orient === '+' ? START : END;
}
function exitSide(h: Home): Side {
	return h.orient === '+' ? END : START;
}
/** Home-sequence coordinate of one side of a segment. */
function sidePos(h: Home, len: number, side: Side): number {
	return side === entrySide(h) ? h.start : h.start + len;
}

// ---------------------------------------------------------------------------
// Home positions

/**
 * A home position for every segment that has one:
 *  - rGFA: the `SN`/`SO`/`SR` tags give it directly;
 *  - otherwise the reference walk(s) (rank 0, coordinates summed along the walk)
 *    and then, for each remaining segment, the first other walk in file order
 *    that visits it (rank = that walk's ordinal, ≥ 1).
 * Segments no walk visits (a reduced graph keeps only the reference walk) have no
 * home and are treated as one-segment alleles.
 */
export function homePositions(gfa: Gfa, referenceSample?: string): Map<string, Home> {
	const homes = new Map<string, Home>();
	let haveRank0Tag = false;
	for (const s of gfa.segments.values()) {
		if (s.rank === 0 && s.stableName !== undefined && s.stableOffset !== undefined) {
			haveRank0Tag = true;
			break;
		}
	}
	if (haveRank0Tag) {
		for (const s of gfa.segments.values()) {
			if (s.stableName === undefined || s.stableOffset === undefined || s.rank === undefined) continue;
			homes.set(s.id, { seq: s.stableName, start: s.stableOffset, rank: s.rank, orient: '+' });
		}
		return homes;
	}

	const real = gfa.walks.filter((w) => w.kind !== 'synthetic');
	const pool = real.length > 0 ? real : gfa.walks;
	let refWalks = referenceSample ? pool.filter((w) => w.sample === referenceSample) : [];
	if (refWalks.length === 0 && pool.length > 0) refWalks = [pool[0]];
	const refSet = new Set(refWalks);

	const visit = (w: Walk, seq: string, rank: number) => {
		let pos = w.start || 0;
		for (const st of w.steps) {
			const seg = gfa.segments.get(st.id);
			if (!seg) continue;
			if (!homes.has(st.id)) homes.set(st.id, { seq, start: pos, rank, orient: st.orient });
			pos += seg.length;
		}
	};
	for (const w of refWalks) visit(w, w.seqId, 0);
	let ordinal = 0;
	for (const w of pool) {
		if (refSet.has(w)) continue;
		ordinal++;
		// The walk's ordinal makes the name unique even when samples are anonymised
		// (every hosted haplotype is `unknown`).
		visit(w, `${ordinal}:${w.sample}#${w.hapIndex}#${w.seqId}`, ordinal);
	}
	return homes;
}

// ---------------------------------------------------------------------------
// Small helpers

class UnionFind {
	private parent = new Map<string, string>();
	find(x: string): string {
		let p = this.parent.get(x);
		if (p === undefined) {
			this.parent.set(x, x);
			return x;
		}
		if (p === x) return x;
		const root = this.find(p);
		this.parent.set(x, root);
		return root;
	}
	/** Union by smaller id, so roots are deterministic. Returns false if already joined. */
	union(a: string, b: string): boolean {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) return false;
		if (ra < rb) this.parent.set(rb, ra);
		else this.parent.set(ra, rb);
		return true;
	}
}

/** Binary min-heap on (dist, id) — ties broken by id so Dijkstra is deterministic. */
class Heap {
	private items: { d: number; id: string }[] = [];
	get size() {
		return this.items.length;
	}
	private less(i: number, j: number): boolean {
		const a = this.items[i];
		const b = this.items[j];
		return a.d < b.d || (a.d === b.d && a.id < b.id);
	}
	push(d: number, id: string) {
		const it = this.items;
		it.push({ d, id });
		let i = it.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.less(i, p)) break;
			[it[i], it[p]] = [it[p], it[i]];
			i = p;
		}
	}
	pop(): { d: number; id: string } {
		const it = this.items;
		const top = it[0];
		const last = it.pop()!;
		if (it.length > 0) {
			it[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < it.length && this.less(l, m)) m = l;
				if (r < it.length && this.less(r, m)) m = r;
				if (m === i) break;
				[it[i], it[m]] = [it[m], it[i]];
				i = m;
			}
		}
		return top;
	}
}

const sideKey = (id: string, side: Side) => `${id}\t${side}`;

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', a: 't', c: 'g', g: 'c', t: 'a', n: 'n' };
function revComp(s: string): string {
	let out = '';
	for (let i = s.length - 1; i >= 0; i--) out += COMPLEMENT[s[i]] ?? s[i];
	return out;
}

// ---------------------------------------------------------------------------
// The fold

export function foldGfa(gfa: Gfa, threshold: number, opts: FoldOptions = {}): FoldResult {
	const homes = opts.homes ?? homePositions(gfa, opts.referenceSample);
	const seg = gfa.segments;
	const len = (id: string) => seg.get(id)?.length ?? 0;
	const isBackbone = (id: string) => homes.get(id)?.rank === 0;

	const identity = (): FoldResult => {
		const repOf = new Map<string, string>();
		for (const id of seg.keys()) repOf.set(id, id);
		return {
			gfa,
			homes,
			repOf,
			applied: false,
			stats: {
				segmentsBefore: seg.size,
				segmentsAfter: seg.size,
				linksBefore: gfa.links.length,
				linksAfter: gfa.links.length,
				alleles: 0,
				keptAlleles: 0,
				routeSegments: 0,
				droppedSkips: 0,
				restoredSkips: 0,
				merged: 0
			}
		};
	};
	let anyBackbone = false;
	for (const id of seg.keys()) if (isBackbone(id)) anyBackbone = true;
	if (!anyBackbone) return identity();

	// Only links between segments that exist; self-loops never join or route.
	const links = gfa.links.filter((l) => seg.has(l.from) && seg.has(l.to));

	// Links attached to each side, for the "what branches here" questions.
	const linksAtSide = new Map<string, number[]>();
	const addAt = (id: string, side: Side, i: number) => {
		const k = sideKey(id, side);
		let arr = linksAtSide.get(k);
		if (!arr) linksAtSide.set(k, (arr = []));
		arr.push(i);
	};
	links.forEach((l, i) => {
		addAt(l.from, fromSide(l), i);
		addAt(l.to, toSide(l), i);
	});

	// --- Step A: alleles ------------------------------------------------------
	// Join two segments when a link reads them in home order with no gap.
	const alleleUf = new UnionFind();
	const isNext = new Array<boolean>(links.length).fill(false);
	links.forEach((l, i) => {
		if (l.from === l.to) return;
		const ha = homes.get(l.from);
		const hb = homes.get(l.to);
		if (!ha || !hb || ha.seq !== hb.seq || ha.rank !== hb.rank) return;
		const sa = fromSide(l);
		const sb = toSide(l);
		const aThenB = sa === exitSide(ha) && sb === entrySide(hb) && ha.start + len(l.from) === hb.start;
		const bThenA = sb === exitSide(hb) && sa === entrySide(ha) && hb.start + len(l.to) === ha.start;
		if (aThenB || bThenA) {
			isNext[i] = true;
			alleleUf.union(l.from, l.to);
		}
	});
	const alleleMembers = new Map<string, string[]>();
	for (const id of seg.keys()) {
		const root = alleleUf.find(id);
		let arr = alleleMembers.get(root);
		if (!arr) alleleMembers.set(root, (arr = []));
		arr.push(id);
	}
	// Home order within each allele (unhomed alleles are single segments).
	for (const members of alleleMembers.values()) {
		members.sort((a, b) => (homes.get(a)?.start ?? 0) - (homes.get(b)?.start ?? 0) || (a < b ? -1 : 1));
	}
	const alleleOf = (id: string) => alleleUf.find(id);

	// --- Step B: allele sizes -------------------------------------------------
	const alleleSize = new Map<string, number>();
	let alleleCount = 0;
	for (const [root, members] of alleleMembers) {
		if (isBackbone(members[0])) {
			alleleSize.set(root, Infinity);
			continue;
		}
		alleleCount++;
		let total = 0;
		const inAllele = new Set(members);
		const attach = new Map<string, { lo: number; hi: number }>();
		for (const id of members) {
			total += len(id);
			for (const side of [START, END] as Side[]) {
				for (const li of linksAtSide.get(sideKey(id, side)) ?? []) {
					const l = links[li];
					// The far end of this link, seen from `id`'s side.
					const atFrom = l.from === id && fromSide(l) === side;
					const otherId = atFrom ? l.to : l.from;
					const otherSide = atFrom ? toSide(l) : fromSide(l);
					if (inAllele.has(otherId) || !isBackbone(otherId)) continue;
					const h = homes.get(otherId)!;
					const p = sidePos(h, len(otherId), otherSide);
					const a = attach.get(h.seq);
					if (a) {
						a.lo = Math.min(a.lo, p);
						a.hi = Math.max(a.hi, p);
					} else attach.set(h.seq, { lo: p, hi: p });
				}
			}
		}
		let span = 0;
		if (attach.size === 1) {
			const a = attach.values().next().value!;
			span = a.hi - a.lo;
		}
		alleleSize.set(root, Math.max(total, span));
	}

	// --- Step C: keep big alleles + their shortest route to the backbone -------
	const adj = new Map<string, string[]>();
	for (const id of seg.keys()) adj.set(id, []);
	for (const l of links) {
		if (l.from === l.to) continue;
		adj.get(l.from)!.push(l.to);
		adj.get(l.to)!.push(l.from);
	}
	for (const nb of adj.values()) nb.sort();

	const dist = new Map<string, number>();
	const pred = new Map<string, string | null>();
	const heap = new Heap();
	for (const id of seg.keys()) {
		if (!isBackbone(id)) continue;
		dist.set(id, 0);
		pred.set(id, null);
		heap.push(0, id);
	}
	const done = new Set<string>();
	while (heap.size > 0) {
		const { d, id } = heap.pop();
		if (done.has(id)) continue;
		done.add(id);
		for (const nb of adj.get(id)!) {
			if (isBackbone(nb)) continue;
			const nd = d + len(nb);
			const cur = dist.get(nb);
			if (cur === undefined || nd < cur || (nd === cur && id < (pred.get(nb) ?? ''))) {
				dist.set(nb, nd);
				pred.set(nb, id);
				heap.push(nd, nb);
			}
		}
	}
	const reach = (id: string) => dist.get(id) ?? Infinity;

	const keep = new Set<string>();
	for (const id of seg.keys()) if (isBackbone(id)) keep.add(id);
	// Segments whose whole predecessor chain is already kept.
	const routed = new Set<string>(keep);
	// Kept non-backbone segments whose sides still need checking (see closure below).
	const toClose: string[] = [];
	const keepRoute = (start: string) => {
		let cur: string | null = start;
		while (cur !== null && !routed.has(cur)) {
			routed.add(cur);
			keep.add(cur);
			toClose.push(cur);
			cur = pred.get(cur) ?? null;
		}
	};
	// A non-backbone side with no link at all is a haplotype leaving the locus (the
	// window edge cuts it off). Such an allele is kept whatever its size: folding
	// must never hide where a haplotype goes off-locus.
	const hasExit = (id: string) =>
		!isBackbone(id) && (!linksAtSide.has(sideKey(id, START)) || !linksAtSide.has(sideKey(id, END)));

	let keptAlleles = 0;
	const sizeOrder = [...alleleMembers.keys()].sort();
	for (const root of sizeOrder) {
		const members = alleleMembers.get(root)!;
		if (isBackbone(members[0])) continue;
		if (alleleSize.get(root)! < threshold && !members.some(hasExit)) continue;
		if (!members.some((id) => Number.isFinite(reach(id)))) continue; // floating free
		keptAlleles++;
		const inAllele = new Set(members);
		for (const id of members) {
			keep.add(id);
			routed.add(id); // the allele is internally connected; its route is below
			toClose.push(id);
		}
		// The allele's two outer ends: the free side of its first and last segment.
		const first = members[0];
		const last = members[members.length - 1];
		const hf = homes.get(first);
		const hl = homes.get(last);
		const ends: [string, Side][] = [
			[first, hf ? entrySide(hf) : START],
			[last, hl ? exitSide(hl) : END]
		];
		let routedAny = false;
		for (const [id, side] of ends) {
			let best: string | null = null;
			for (const li of linksAtSide.get(sideKey(id, side)) ?? []) {
				const l = links[li];
				const otherId = l.from === id && fromSide(l) === side ? l.to : l.from;
				if (inAllele.has(otherId)) continue;
				if (
					best === null ||
					reach(otherId) < reach(best) ||
					(reach(otherId) === reach(best) && otherId < best)
				)
					best = otherId;
			}
			if (best !== null && Number.isFinite(reach(best))) {
				keepRoute(best);
				routedAny = true;
			}
		}
		if (!routedAny) {
			// Both ends dangle (window edge): route from wherever the allele is closest.
			let best = members[0];
			for (const id of members) if (reach(id) < reach(best)) best = id;
			const p = pred.get(best);
			if (p) keepRoute(p);
		}
	}
	// Close every kept segment off: a side that had links in the input keeps at least
	// one, routing it back to the backbone like an allele end. Otherwise a route
	// segment (kept for the side facing the backbone) would leave its other side
	// hanging, and a hanging side is drawn as a haplotype leaving the locus.
	while (toClose.length > 0) {
		const id = toClose.pop()!;
		for (const side of [START, END] as Side[]) {
			let best: string | null = null;
			let closed = false;
			for (const li of linksAtSide.get(sideKey(id, side)) ?? []) {
				const l = links[li];
				const otherId = l.from === id && fromSide(l) === side ? l.to : l.from;
				if (keep.has(otherId)) {
					closed = true;
					break;
				}
				if (
					best === null ||
					reach(otherId) < reach(best) ||
					(reach(otherId) === reach(best) && otherId < best)
				)
					best = otherId;
			}
			if (!closed && best !== null && Number.isFinite(reach(best))) keepRoute(best);
		}
	}
	let routeSegments = 0;
	for (const id of keep) {
		if (isBackbone(id)) continue;
		if ((alleleSize.get(alleleOf(id)) ?? 0) < threshold) routeSegments++;
	}

	// --- Step D: drop small deletion links -------------------------------------
	const keptLinkIdx: number[] = [];
	const skipCandidates: { i: number; skip: number }[] = [];
	links.forEach((l, i) => {
		if (!keep.has(l.from) || !keep.has(l.to)) return;
		if (!isNext[i] && l.from !== l.to) {
			const ha = homes.get(l.from);
			const hb = homes.get(l.to);
			if (ha && hb && ha.seq === hb.seq && ha.rank === hb.rank) {
				const pa = sidePos(ha, len(l.from), fromSide(l));
				const pb = sidePos(hb, len(l.to), toSide(l));
				const skip = Math.abs(pb - pa);
				if (skip > 0 && skip < threshold) {
					skipCandidates.push({ i, skip });
					return;
				}
			}
		}
		keptLinkIdx.push(i);
	});
	// A skip that is the last link on one of its sides stays: dropping it would
	// leave that side hanging, drawn as a haplotype leaving the locus.
	const linksOnSide = new Map<string, number>();
	const bumpSides = (i: number, d: number) => {
		const l = links[i];
		for (const k of [sideKey(l.from, fromSide(l)), sideKey(l.to, toSide(l))])
			linksOnSide.set(k, (linksOnSide.get(k) ?? 0) + d);
	};
	for (const i of keptLinkIdx) bumpSides(i, 1);
	for (const { i } of skipCandidates) bumpSides(i, 1);
	skipCandidates.sort((a, b) => a.skip - b.skip || a.i - b.i);
	let restoredSkips = 0;
	const droppable: typeof skipCandidates = [];
	for (const c of skipCandidates) {
		const l = links[c.i];
		const lone =
			linksOnSide.get(sideKey(l.from, fromSide(l)))! <= 1 || linksOnSide.get(sideKey(l.to, toSide(l)))! <= 1;
		if (lone) {
			keptLinkIdx.push(c.i);
			restoredSkips++;
		} else {
			bumpSides(c.i, -1);
			droppable.push(c);
		}
	}
	// Reconnect: union-find over the kept links, then add back the shortest dropped
	// skips that join pieces which would otherwise float free (a window edge that
	// falls inside a small deletion).
	const compUf = new UnionFind();
	for (const id of keep) compUf.find(id);
	for (const i of keptLinkIdx) compUf.union(links[i].from, links[i].to);
	for (const { i } of droppable) {
		if (compUf.union(links[i].from, links[i].to)) {
			keptLinkIdx.push(i);
			restoredSkips++;
		}
	}
	keptLinkIdx.sort((a, b) => a - b);

	// --- Step E: merge non-branching runs of the same allele -------------------
	const keptAtSide = new Map<string, number>();
	for (const i of keptLinkIdx) {
		const l = links[i];
		const ka = sideKey(l.from, fromSide(l));
		const kb = sideKey(l.to, toSide(l));
		keptAtSide.set(ka, (keptAtSide.get(ka) ?? 0) + 1);
		keptAtSide.set(kb, (keptAtSide.get(kb) ?? 0) + 1);
	}
	const mergeUf = new UnionFind();
	const mergeLink = new Set<number>();
	for (const i of keptLinkIdx) {
		if (!isNext[i]) continue;
		const l = links[i];
		if (alleleOf(l.from) !== alleleOf(l.to)) continue;
		if (keptAtSide.get(sideKey(l.from, fromSide(l))) !== 1) continue;
		if (keptAtSide.get(sideKey(l.to, toSide(l))) !== 1) continue;
		mergeUf.union(l.from, l.to);
		mergeLink.add(i);
	}
	const groups = new Map<string, string[]>();
	for (const id of seg.keys()) {
		if (!keep.has(id)) continue;
		const root = mergeUf.find(id);
		let g = groups.get(root);
		if (!g) groups.set(root, (g = []));
		g.push(id);
	}

	const outSegments = new Map<string, Segment>();
	const outHomes = new Map<string, Home>();
	const repOf = new Map<string, string>();
	/** For merged members: the rep, and whether the member reads forward in it. */
	const memberInfo = new Map<string, { rep: string; forward: boolean; first: boolean; last: boolean }>();
	let merged = 0;
	// Keep the input's segment order (first member of each group stands in place).
	for (const id of seg.keys()) {
		if (!keep.has(id)) continue;
		const g = groups.get(mergeUf.find(id))!;
		if (g.length === 1) {
			outSegments.set(id, seg.get(id)!);
			const h = homes.get(id);
			if (h) outHomes.set(id, h);
			repOf.set(id, id);
			continue;
		}
		g.sort((a, b) => homes.get(a)!.start - homes.get(b)!.start);
		if (g[0] !== id) continue; // emitted when its first member is reached
		const first = seg.get(g[0])!;
		let length = 0;
		let seqOk = true;
		let sequence = '';
		const members: string[] = [];
		let coverage: number | undefined;
		for (const m of g) {
			const s = seg.get(m)!;
			const h = homes.get(m)!;
			length += s.length;
			if (s.seq && s.seq.length === s.length) sequence += h.orient === '+' ? s.seq : revComp(s.seq);
			else seqOk = false;
			members.push(...(s.members && s.members.length ? s.members : [m]));
			if (s.coverage !== undefined) coverage = Math.max(coverage ?? 0, s.coverage);
			repOf.set(m, g[0]);
			memberInfo.set(m, { rep: g[0], forward: h.orient === '+', first: m === g[0], last: m === g[g.length - 1] });
		}
		merged += g.length - 1;
		const h0 = homes.get(g[0])!;
		outSegments.set(g[0], {
			...first,
			length,
			seq: seqOk ? sequence : '',
			members,
			coverage,
			walkStarts: seg.get(g[0])!.walkStarts,
			walkEnds: seg.get(g[g.length - 1])!.walkEnds
		});
		outHomes.set(g[0], { ...h0, orient: '+' });
	}

	// Remap a link side onto the output: merged members expose only their run's
	// outer sides (home entry of the first → START, home exit of the last → END).
	const remapSide = (id: string, side: Side): { id: string; side: Side } | null => {
		const mi = memberInfo.get(id);
		if (!mi) return { id, side };
		const h = homes.get(id)!;
		if (mi.first && side === entrySide(h)) return { id: mi.rep, side: START };
		if (mi.last && side === exitSide(h)) return { id: mi.rep, side: END };
		return null; // an internal junction (the merge link itself)
	};
	const outLinks: Link[] = [];
	const seenLink = new Map<string, Link>();
	for (const i of keptLinkIdx) {
		if (mergeLink.has(i)) continue;
		const l = links[i];
		const a = remapSide(l.from, fromSide(l));
		const b = remapSide(l.to, toSide(l));
		if (!a || !b) continue;
		const nl: Link = {
			from: a.id,
			fromOrient: a.side === END ? '+' : '-',
			to: b.id,
			toOrient: b.side === START ? '+' : '-',
			coverage: l.coverage
		};
		// A link and its reverse complement are the same edge.
		const k1 = `${nl.from}${nl.fromOrient}${nl.to}${nl.toOrient}`;
		const flip = (o: Orient): Orient => (o === '+' ? '-' : '+');
		const k2 = `${nl.to}${flip(nl.toOrient)}${nl.from}${flip(nl.fromOrient)}`;
		const prev = seenLink.get(k1) ?? seenLink.get(k2);
		if (prev) {
			if (nl.coverage !== undefined) prev.coverage = Math.max(prev.coverage ?? 0, nl.coverage);
			continue;
		}
		seenLink.set(k1, nl);
		outLinks.push(nl);
	}

	// --- Walks: reroute through the kept segments -------------------------------
	const outSideLinks = new Map<string, { id: string; side: Side }[]>();
	for (const l of outLinks) {
		const a = { id: l.from, side: fromSide(l) };
		const b = { id: l.to, side: toSide(l) };
		const ka = sideKey(a.id, a.side);
		const kb = sideKey(b.id, b.side);
		(outSideLinks.get(ka) ?? outSideLinks.set(ka, []).get(ka)!).push(b);
		(outSideLinks.get(kb) ?? outSideLinks.set(kb, []).get(kb)!).push(a);
	}
	const exitOf = (st: Step): Side => (st.orient === '+' ? END : START);
	const entryOf = (st: Step): Side => (st.orient === '+' ? START : END);
	const linked = (p: Step, q: Step) =>
		(outSideLinks.get(sideKey(p.id, exitOf(p))) ?? []).some((o) => o.id === q.id && o.side === entryOf(q));
	// Shortest kept path (by hops, bounded) from leaving `p` to entering `q`.
	const bridge = (p: Step, q: Step): Step[] | null => {
		const LIMIT = 64;
		const startKey = sideKey(p.id, exitOf(p));
		const back = new Map<string, { prev: string; step: Step } | null>([[startKey, null]]);
		const queue = [startKey];
		let head = 0;
		while (head < queue.length && back.size < LIMIT) {
			const k = queue[head++];
			for (const o of outSideLinks.get(k) ?? []) {
				if (o.id === q.id && o.side === entryOf(q)) {
					const path: Step[] = [];
					let cur: string | null = k;
					while (cur !== null && cur !== startKey) {
						const b: { prev: string; step: Step } = back.get(cur)!;
						path.push(b.step);
						cur = b.prev;
					}
					return path.reverse();
				}
				if (o.id === q.id || o.id === p.id) continue;
				const st: Step = { id: o.id, orient: o.side === START ? '+' : '-' };
				const outKey = sideKey(o.id, exitOf(st));
				if (back.has(outKey)) continue;
				back.set(outKey, { prev: k, step: st });
				queue.push(outKey);
			}
		}
		return null;
	};
	const outWalks: Walk[] = gfa.walks.map((w) => {
		const mapped: Step[] = [];
		for (const st of w.steps) {
			const rep = repOf.get(st.id);
			if (rep === undefined) continue;
			const mi = memberInfo.get(st.id);
			const ns: Step = mi ? { id: rep, orient: (st.orient === '+') === mi.forward ? '+' : '-' } : st;
			const prev = mapped[mapped.length - 1];
			if (prev && prev.id === ns.id && prev.orient === ns.orient && mi) continue; // same run
			if (prev && !linked(prev, ns)) {
				const fill = bridge(prev, ns);
				if (fill) mapped.push(...fill);
			}
			mapped.push(ns);
		}
		return { ...w, steps: mapped };
	});

	return {
		gfa: { ...gfa, segments: outSegments, links: outLinks, walks: outWalks },
		homes: outHomes,
		repOf,
		applied: true,
		stats: {
			segmentsBefore: seg.size,
			segmentsAfter: outSegments.size,
			linksBefore: gfa.links.length,
			linksAfter: outLinks.length,
			alleles: alleleCount,
			keptAlleles,
			routeSegments,
			droppedSkips: skipCandidates.length - restoredSkips,
			restoredSkips,
			merged
		}
	};
}

/** Threshold that hides variants smaller than `px` screen pixels at `bpPerPx`. */
export function zoomThreshold(bpPerPx: number, px = 10): number {
	return Math.max(0, px * bpPerPx);
}

/** Reference length in bp: the reference walk(s), or the first walk. */
export function referenceBp(gfa: Gfa, referenceSample?: string): number {
	let walks = referenceSample ? gfa.walks.filter((w) => w.sample === referenceSample) : [];
	if (walks.length === 0 && gfa.walks.length > 0) walks = [gfa.walks[0]];
	let bp = 0;
	for (const w of walks) for (const st of w.steps) bp += gfa.segments.get(st.id)?.length ?? 0;
	return bp;
}

/** Round down to 1, 2 or 5 × a power of ten, for a readable threshold. */
export function niceBp(x: number): number {
	if (!(x > 1)) return 1;
	const p = 10 ** Math.floor(Math.log10(x));
	const m = x / p;
	return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
