// Reference-guided graph simplification. Runs upfront on the parsed Gfa so every
// widget consumes the reduced graph. Two phases:
//
//   1. popSmallVariants — find small *superbubbles* anchored on two reference
//      nodes and collapse them to the reference, rerouting the haplotypes that
//      took an alt path. A site is a single-entry/single-exit, self-contained,
//      acyclic region; we collapse it iff its LONGEST entry→exit path measures
//      < N bases (so "all paths < N", covering SNPs, small indels and MNPs /
//      overlapping small variants). Longest path is a topological-order DP — no
//      path enumeration. Because the size is the longest path (which includes
//      the reference span), a tiny deletion allele that skips a long reference
//      stretch is correctly seen as large and kept. Cycles/inversions fail the
//      DAG check and large SVs fail the size check, so both survive untouched.
//
//   2. unchop — merge maximal co-oriented non-branching node chains into single
//      nodes (the big node-count win on long reference runs). Purely a
//      representation change; introduces no new adjacencies.
//
// Safety invariant both phases preserve: every edge in the output corresponds to
// an adjacency that existed in the input (no spurious connections), and the
// reference sequence is unchanged.
import type { Gfa, Link, Orient, Segment, Step } from '../gfa';

export interface SimplifyOptions {
	referenceSample?: string;
	/** Collapse a site when its longest entry→exit path is < this (bp). */
	maxVariant?: number;
	/** Also merge non-branching chains. Default true. */
	unchop?: boolean;
}

export interface CollapsedSite {
	entry: string;
	exit: string;
	contig: string;
	/** Reference bp span between the anchors (0 for a pure insertion). */
	refSpan: number;
	leftBp: number;
	rightBp: number;
	/** Non-reference interior nodes removed. */
	nodesRemoved: number;
	/** Removed interior nodes that were single-base (SNPs). */
	snpCount: number;
	/** Total non-reference interior bases condensed. */
	basesRemoved: number;
	/** Longest entry→exit path through the site, in bases. */
	maxPathBases: number;
	haplotypesAffected: number;
}

export interface SimplifyStats {
	segmentsBefore: number;
	segmentsAfter: number;
	linksBefore: number;
	linksAfter: number;
	sites: number;
	nodesRemoved: number;
	snpCount: number;
	basesRemoved: number;
	unchopMerges: number;
}

export interface SimplifyResult {
	gfa: Gfa;
	sites: CollapsedSite[];
	stats: SimplifyStats;
}

const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

function flip(o: Orient): Orient {
	return o === '+' ? '-' : '+';
}

function cloneGfa(gfa: Gfa): Gfa {
	return {
		headers: [...gfa.headers],
		segments: new Map([...gfa.segments].map(([k, v]) => [k, { ...v }])),
		links: gfa.links.map((l) => ({ ...l })),
		// Steps are never mutated in place anywhere in this module (both phases
		// below always build a fresh `out` array and reassign `w.steps = out`
		// rather than editing an existing step), so it's safe — and much
		// cheaper for large graphs — to share the step objects and only copy
		// the array that holds them.
		walks: gfa.walks.map((w) => ({ ...w, steps: w.steps.slice(), tags: { ...w.tags } })),
		referenceSamples: [...gfa.referenceSamples]
	};
}

// ---------------------------------------------------------------------------
// Phase 1: pop small superbubbles
// ---------------------------------------------------------------------------

interface Region {
	entry: string;
	exit: string;
	interiorNonRef: string[];
	longest: number;
	snpCount: number;
	basesRemoved: number;
	refSpan: number;
}

export function popSmallVariants(input: Gfa, opts: SimplifyOptions = {}): SimplifyResult {
	const maxVariant = opts.maxVariant ?? 50;
	const gfa = cloneGfa(input);
	const emptyStats = (): SimplifyStats => ({
		segmentsBefore: input.segments.size,
		segmentsAfter: input.segments.size,
		linksBefore: input.links.length,
		linksAfter: input.links.length,
		sites: 0,
		nodesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		unchopMerges: 0
	});

	const ref = gfa.walks.find((w) => w.sample === opts.referenceSample) ?? gfa.walks[0];
	if (!ref) return { gfa, sites: [], stats: emptyStats() };

	// Reference chain + coordinates + duplicate guard.
	const refIndex = new Map<string, number>();
	const refDup = new Set<string>();
	const refNodeAt: string[] = [];
	const cumStart: number[] = [];
	let off = 0;
	ref.steps.forEach((s, i) => {
		if (refIndex.has(s.id)) refDup.add(s.id);
		else refIndex.set(s.id, i);
		refNodeAt[i] = s.id;
		cumStart[i] = off;
		off += gfa.segments.get(s.id)?.length ?? 0;
	});
	const refSet = new Set(refIndex.keys());
	const idxOf = (id: string) => refIndex.get(id)!;
	const len = (id: string) => gfa.segments.get(id)?.length ?? 0;

	// Directed edges from haplotype walks (traversal direction — so orientation /
	// inversions are handled without bidirected-edge reasoning), the undirected
	// link structure, and which edges are actually covered by a walk.
	const dirOut = new Map<string, Set<string>>();
	const dirIn = new Map<string, Set<string>>();
	const adj = new Map<string, Set<string>>();
	const walkPairs = new Set<string>();
	const selfLoop = new Set<string>(); // nodes with a tandem self-edge (a cycle)
	const add = (m: Map<string, Set<string>>, a: string, b: string) => {
		let s = m.get(a);
		if (!s) m.set(a, (s = new Set()));
		s.add(b);
	};
	for (const w of gfa.walks) {
		for (let i = 0; i + 1 < w.steps.length; i++) {
			const a = w.steps[i].id;
			const b = w.steps[i + 1].id;
			if (a === b) {
				selfLoop.add(a);
				continue;
			}
			add(dirOut, a, b);
			add(dirIn, b, a);
			walkPairs.add(pairKey(a, b));
		}
	}
	for (const l of gfa.links) {
		if (!gfa.segments.has(l.from) || !gfa.segments.has(l.to)) continue;
		if (l.from === l.to) {
			selfLoop.add(l.from);
			continue;
		}
		add(adj, l.from, l.to);
		add(adj, l.to, l.from);
	}

	// Find the smallest superbubble whose entry is the reference node r_sIdx.
	function detect(sIdx: number): Region | null {
		const s = refNodeAt[sIdx];
		if ((dirOut.get(s)?.size ?? 0) < 2) return null; // an entry must branch

		// Bounded forward cone: keep only nodes whose min interior-base prefix from
		// s is < maxVariant (a <N interior can't reach further).
		const prefix = new Map<string, number>([[s, 0]]);
		const cone = new Set<string>([s]);
		const pq: Array<[number, string]> = [[0, s]];
		while (pq.length) {
			let bi = 0;
			for (let k = 1; k < pq.length; k++) if (pq[k][0] < pq[bi][0]) bi = k;
			const [d, u] = pq.splice(bi, 1)[0];
			if (d > (prefix.get(u) ?? Infinity)) continue;
			if (u !== s && d >= maxVariant) continue; // too deep to be interior
			for (const v of dirOut.get(u) ?? []) {
				if (refSet.has(v) && idxOf(v) < sIdx) return null; // backward edge → not a forward bubble
				const nd = d + (u === s ? 0 : len(u));
				if (nd < (prefix.get(v) ?? Infinity)) {
					prefix.set(v, nd);
					cone.add(v);
					if (cone.size > 512) return null;
					pq.push([nd, v]);
				}
			}
		}

		const exits = [...cone]
			.filter((x) => refSet.has(x) && idxOf(x) > sIdx)
			.sort((a, b) => idxOf(a) - idxOf(b));

		for (const t of exits) {
			// Backward reach from t within the cone.
			const back = new Set<string>([t]);
			const q = [t];
			while (q.length) {
				const u = q.shift()!;
				for (const p of dirIn.get(u) ?? []) if (cone.has(p) && !back.has(p)) { back.add(p); q.push(p); }
			}
			const interior = [...cone].filter((x) => x !== s && x !== t && back.has(x));
			const region = new Set<string>([s, t, ...interior]);

			// Closed? Any interior neighbour, s out-edge, or t in-edge that leaves the
			// region means the bubble hasn't reconnected yet — try a larger exit.
			let leak = false;
			for (const u of interior) for (const w of adj.get(u) ?? []) if (!region.has(w)) leak = true;
			for (const w of dirOut.get(s) ?? []) if (!region.has(w)) leak = true;
			for (const w of dirIn.get(t) ?? []) if (!region.has(w)) leak = true;
			if (leak) continue;

			// A tandem self-loop anywhere in the region is a cycle — never collapse.
			let hasSelf = false;
			for (const n of region) if (selfLoop.has(n)) hasSelf = true;
			if (hasSelf) return null;

			const interiorNonRef = interior.filter((x) => !refSet.has(x));
			const hasSkip = (dirOut.get(s)?.has(t) ?? false) && idxOf(t) > sIdx + 1;
			if (interiorNonRef.length === 0 && !hasSkip) continue; // no variation here

			// Single-source (s) / single-sink (t) over walk-directed edges.
			const indeg = new Map<string, number>();
			for (const n of region) indeg.set(n, 0);
			for (const u of region) for (const v of dirOut.get(u) ?? []) if (region.has(v)) indeg.set(v, indeg.get(v)! + 1);
			let ok = true;
			for (const n of region) {
				let out = 0;
				for (const v of dirOut.get(n) ?? []) if (region.has(v)) out++;
				const inc = indeg.get(n)!;
				if (n === s) { if (inc !== 0) ok = false; } else if (inc === 0) ok = false;
				if (n === t) { if (out !== 0) ok = false; } else if (out === 0) ok = false;
			}
			if (!ok) return null;

			// Acyclic (Kahn) — catches inversions / tandem repeats.
			const ind = new Map(indeg);
			const ready = [...region].filter((n) => ind.get(n) === 0);
			const topo: string[] = [];
			while (ready.length) {
				const u = ready.shift()!;
				topo.push(u);
				for (const v of dirOut.get(u) ?? []) if (region.has(v)) { ind.set(v, ind.get(v)! - 1); if (ind.get(v) === 0) ready.push(v); }
			}
			if (topo.length !== region.size) return null; // cycle

			// Every graph edge inside the region must be covered by a walk, else we
			// can't reason about its direction — keep the site to be safe.
			for (const u of region) for (const w of adj.get(u) ?? []) if (region.has(w) && u < w && !walkPairs.has(pairKey(u, w))) return null;

			// Longest entry→exit path in bases (interior node lengths). Includes the
			// reference span, so a deletion over a long reference node reads as large.
			const dp = new Map<string, number>();
			for (const n of region) dp.set(n, -Infinity);
			dp.set(s, 0);
			for (const u of topo) {
				const du = dp.get(u)!;
				if (du === -Infinity) continue;
				for (const v of dirOut.get(u) ?? []) if (region.has(v)) {
					const cand = du + (v === t ? 0 : len(v));
					if (cand > dp.get(v)!) dp.set(v, cand);
				}
			}
			const longest = dp.get(t)!;
			if (longest >= maxVariant) return null; // too big — keep (a larger exit only grows it)

			let refSpan = 0;
			for (let i = sIdx + 1; i < idxOf(t); i++) refSpan += len(refNodeAt[i]);
			return {
				entry: s,
				exit: t,
				interiorNonRef,
				longest,
				snpCount: interiorNonRef.filter((x) => len(x) === 1).length,
				basesRemoved: interiorNonRef.reduce((n, x) => n + len(x), 0),
				refSpan
			};
		}
		return null;
	}

	const removedNodes = new Set<string>();
	const collapsedSpans: Array<[number, number]> = [];
	const claimedInterior = new Set<string>();
	const sites: CollapsedSite[] = [];

	for (let i = 0; i < refNodeAt.length; i++) {
		const s = refNodeAt[i];
		if (refDup.has(s) || claimedInterior.has(s)) continue;
		const r = detect(i);
		if (!r) continue;
		for (const n of r.interiorNonRef) removedNodes.add(n);
		for (let k = i + 1; k < idxOf(r.exit); k++) claimedInterior.add(refNodeAt[k]);
		collapsedSpans.push([i, idxOf(r.exit)]);
		sites.push({
			entry: r.entry,
			exit: r.exit,
			contig: ref.seqId,
			refSpan: r.refSpan,
			leftBp: (ref.start ?? 0) + cumStart[i] + len(s),
			rightBp: (ref.start ?? 0) + cumStart[idxOf(r.exit)],
			nodesRemoved: r.interiorNonRef.length,
			snpCount: r.snpCount,
			basesRemoved: r.basesRemoved,
			maxPathBases: r.longest,
			haplotypesAffected: 0
		});
	}

	// Reference interior steps between any two reference nodes (always exists).
	// The forward-orientation branch reuses the reference's own step objects
	// (never mutated downstream); the reversed branch must still build new ones
	// since the orientation is flipped.
	const interiorBetween = (fromId: string, toId: string): Step[] => {
		const a = idxOf(fromId);
		const b = idxOf(toId);
		if (a < b) return ref.steps.slice(a + 1, b);
		return ref.steps.slice(b + 1, a).reverse().map((s) => ({ id: s.id, orient: flip(s.orient) }));
	};
	const spanOf = (a: string, b: string): number => {
		const lo = Math.min(idxOf(a), idxOf(b));
		const hi = Math.max(idxOf(a), idxOf(b));
		return collapsedSpans.findIndex(([l, h]) => l <= lo && hi <= h);
	};

	// Reroute walks that took a collapsed path back onto the reference.
	const affected = collapsedSpans.map(() => 0);
	for (const w of gfa.walks) {
		if (w === ref) continue;
		const out: Step[] = [];
		const hitSpans = new Set<number>();
		let i = 0;
		while (i < w.steps.length) {
			const cur = w.steps[i];
			if (removedNodes.has(cur.id)) {
				let j = i;
				while (j < w.steps.length && removedNodes.has(w.steps[j].id)) j++;
				const from = out[out.length - 1]?.id;
				const to = w.steps[j]?.id;
				if (from && to && refSet.has(from) && refSet.has(to)) {
					out.push(...interiorBetween(from, to));
					const si = spanOf(from, to);
					if (si >= 0) hitSpans.add(si);
				}
				i = j;
			} else {
				const prev = out[out.length - 1]?.id;
				if (
					prev &&
					refSet.has(prev) &&
					refSet.has(cur.id) &&
					Math.abs(idxOf(prev) - idxOf(cur.id)) >= 2 &&
					spanOf(prev, cur.id) >= 0
				) {
					out.push(...interiorBetween(prev, cur.id));
					hitSpans.add(spanOf(prev, cur.id));
				}
				out.push(cur);
				i++;
			}
		}
		w.steps = out;
		for (const si of hitSpans) affected[si]++;
	}
	sites.forEach((s, si) => (s.haplotypesAffected = affected[si]));

	// Rebuild: drop removed nodes and non-reference edges inside collapsed spans.
	for (const id of removedNodes) gfa.segments.delete(id);
	gfa.links = gfa.links.filter((l) => {
		if (removedNodes.has(l.from) || removedNodes.has(l.to)) return false;
		if (
			l.from !== l.to &&
			refSet.has(l.from) &&
			refSet.has(l.to) &&
			Math.abs(idxOf(l.from) - idxOf(l.to)) >= 2 &&
			spanOf(l.from, l.to) >= 0
		)
			return false;
		return true;
	});

	const stats: SimplifyStats = {
		segmentsBefore: input.segments.size,
		segmentsAfter: gfa.segments.size,
		linksBefore: input.links.length,
		linksAfter: gfa.links.length,
		sites: sites.length,
		nodesRemoved: sites.reduce((n, s) => n + s.nodesRemoved, 0),
		snpCount: sites.reduce((n, s) => n + s.snpCount, 0),
		basesRemoved: sites.reduce((n, s) => n + s.basesRemoved, 0),
		unchopMerges: 0
	};
	return { gfa, sites, stats };
}

// ---------------------------------------------------------------------------
// Phase 2: unchop (merge co-oriented non-branching chains)
// ---------------------------------------------------------------------------

export function unchop(input: Gfa): { gfa: Gfa; merges: number } {
	const gfa = cloneGfa(input);

	// End-usage counts: which end (L/R) of each node each link touches.
	const lEnd = new Map<string, number>();
	const rEnd = new Map<string, number>();
	const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
	// Co-oriented forward links (from.R -> to.L), i.e. fromOrient=+ toOrient=+.
	const fwdOut = new Map<string, string>(); // from -> to (only if unique-eligible)
	const fwdOutCount = new Map<string, number>();
	const fwdInCount = new Map<string, number>();
	for (const l of gfa.links) {
		if (!gfa.segments.has(l.from) || !gfa.segments.has(l.to)) continue;
		bump(l.fromOrient === '+' ? rEnd : lEnd, l.from);
		bump(l.toOrient === '+' ? lEnd : rEnd, l.to);
		if (l.from !== l.to && l.fromOrient === '+' && l.toOrient === '+') {
			fwdOut.set(l.from, l.to);
			bump(fwdOutCount, l.from);
			bump(fwdInCount, l.to);
		}
	}

	// x merges forward into y iff the only thing on x's right end and y's left
	// end is the single co-oriented x->y link.
	const mergeNext = new Map<string, string>();
	for (const [x, y] of fwdOut) {
		if ((fwdOutCount.get(x) ?? 0) === 1 && (rEnd.get(x) ?? 0) === 1 && (lEnd.get(y) ?? 0) === 1 && (fwdInCount.get(y) ?? 0) === 1) {
			mergeNext.set(x, y);
		}
	}
	const hasPrev = new Set(mergeNext.values());

	// Build chains starting from nodes that aren't a merge target.
	const chainOf = new Map<string, { id: string; index: number; members: string[] }>();
	let merges = 0;
	const newSegments = new Map<string, Segment>();
	const mergedMembers = new Map<string, string[]>();

	const consumed = new Set<string>();
	for (const startId of gfa.segments.keys()) {
		if (consumed.has(startId) || hasPrev.has(startId)) continue;
		const members: string[] = [startId];
		let cur = startId;
		while (mergeNext.has(cur)) {
			cur = mergeNext.get(cur)!;
			members.push(cur);
		}
		for (const m of members) consumed.add(m);
		if (members.length === 1) {
			newSegments.set(startId, { ...gfa.segments.get(startId)! });
			continue;
		}
		merges += members.length - 1;
		const chainId = `u${members[0]}`;
		let seqParts: string[] = [];
		let length = 0;
		let hasSeq = true;
		for (const m of members) {
			const s = gfa.segments.get(m)!;
			length += s.length;
			if (s.seq) seqParts.push(s.seq);
			else hasSeq = false;
		}
		newSegments.set(chainId, { id: chainId, seq: hasSeq ? seqParts.join('') : '', length });
		mergedMembers.set(chainId, members);
		members.forEach((m, index) => chainOf.set(m, { id: chainId, index, members }));
	}

	// Rewrite links: drop internal chain links; remap external endpoints.
	const links: Link[] = [];
	for (const l of gfa.links) {
		if (!gfa.segments.has(l.from) || !gfa.segments.has(l.to)) continue;
		const cf = chainOf.get(l.from);
		const ct = chainOf.get(l.to);
		// internal forward chain link between consecutive members -> drop
		if (cf && ct && cf.id === ct.id && ct.index === cf.index + 1) continue;
		links.push({
			from: cf ? cf.id : l.from,
			fromOrient: l.fromOrient,
			to: ct ? ct.id : l.to,
			toOrient: l.toOrient
		});
	}

	// Materialize non-chain segments untouched.
	for (const [id, seg] of gfa.segments) if (!chainOf.has(id) && !newSegments.has(id)) newSegments.set(id, { ...seg });

	// Rewrite walks: collapse consecutive same-chain runs into one step.
	for (const w of gfa.walks) {
		const out: Step[] = [];
		let i = 0;
		while (i < w.steps.length) {
			const c = chainOf.get(w.steps[i].id);
			if (!c) {
				out.push(w.steps[i]);
				i++;
				continue;
			}
			const orient = w.steps[i].orient;
			let j = i + 1;
			while (j < w.steps.length && chainOf.get(w.steps[j].id)?.id === c.id) j++;
			out.push({ id: c.id, orient });
			i = j;
		}
		w.steps = out;
	}

	gfa.segments = newSegments;
	gfa.links = links;
	return { gfa, merges };
}

// ---------------------------------------------------------------------------
// Combined pipeline
// ---------------------------------------------------------------------------

export function simplify(input: Gfa, opts: SimplifyOptions = {}): SimplifyResult {
	const popped = popSmallVariants(input, opts);
	if (opts.unchop === false) return popped;
	const { gfa, merges } = unchop(popped.gfa);
	return {
		gfa,
		sites: popped.sites,
		stats: {
			...popped.stats,
			segmentsAfter: gfa.segments.size,
			linksAfter: gfa.links.length,
			unchopMerges: merges
		}
	};
}
