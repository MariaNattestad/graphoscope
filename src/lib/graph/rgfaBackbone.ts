// Recover a *real* reference backbone from rGFA stable-sequence tags.
//
// minigraph's rGFA marks each segment with the stable sequence it came from:
//   SN:Z:<contig>   the reference/contig name
//   SO:i:<offset>   the 0-based offset of this segment on that contig
//   SR:i:<rank>     stable rank; 0 is the linear reference, >0 are inserted alleles
//
// So a graph with no W- or P-lines can still carry an exact reference: the rank-0
// segments, ordered by their offset, ARE the reference path — with true genomic
// coordinates, not a guess. That's strictly better than the longest-path heuristic
// when the tags are present, and it lets the coordinate axis show real positions.

import type { Gfa, Step } from '../gfa';

export interface RgfaBackbone {
	steps: Step[];
	/** Total sequence length (bp) along the backbone. */
	bp: number;
	/** The stable contig this backbone follows (its `SN`), for the axis label. */
	contig: string;
	/** Genomic start (min `SO`) of the backbone on that contig. */
	start: number;
}

/**
 * Build a reference backbone from rGFA tags, or `null` when the graph has no
 * usable rank-0 tagged segments. When several stable contigs are present the
 * longest (by summed segment bp) is chosen — the main reference sequence.
 */
export function rgfaBackbone(gfa: Gfa): RgfaBackbone | null {
	// Rank-0 segments with a stable name and offset are the reference.
	interface RefSeg {
		id: string;
		contig: string;
		offset: number;
		length: number;
	}
	const byContig = new Map<string, RefSeg[]>();
	for (const s of gfa.segments.values()) {
		if (s.rank !== 0 || s.stableName === undefined || s.stableOffset === undefined) continue;
		let arr = byContig.get(s.stableName);
		if (!arr) byContig.set(s.stableName, (arr = []));
		arr.push({ id: s.id, contig: s.stableName, offset: s.stableOffset, length: s.length });
	}
	if (byContig.size === 0) return null;

	// Pick the contig carrying the most reference sequence.
	let bestContig: string | null = null;
	let bestBp = -1;
	for (const [contig, segs] of byContig) {
		let bp = 0;
		for (const s of segs) bp += s.length;
		if (bp > bestBp) {
			bestBp = bp;
			bestContig = contig;
		}
	}
	if (bestContig == null) return null;

	const segs = byContig.get(bestContig)!;
	segs.sort((a, b) => a.offset - b.offset);
	const ids = segs.map((s) => s.id);
	let start = segs[0].offset;
	let bp = 0;
	for (const s of segs) bp += s.length;

	// Some rGFAs leave a shared root/tip segment untagged (e.g. gfatools' MT.gfa
	// doesn't tag its first segment). Extend the rank-0 chain through such untagged
	// neighbours at either end — following an unambiguous single link — so the
	// backbone stays whole and its coordinates start at the true 0.
	const inAdj = new Map<string, string[]>();
	const outAdj = new Map<string, string[]>();
	for (const l of gfa.links) {
		if (!gfa.segments.has(l.from) || !gfa.segments.has(l.to)) continue;
		(outAdj.get(l.from) ?? outAdj.set(l.from, []).get(l.from)!).push(l.to);
		(inAdj.get(l.to) ?? inAdj.set(l.to, []).get(l.to)!).push(l.from);
	}
	const inPath = new Set(ids);
	const isUntagged = (id: string) => gfa.segments.get(id)?.rank === undefined;
	const lenOf = (id: string) => gfa.segments.get(id)?.length ?? 0;

	// Prepend: a single untagged predecessor of the current first segment.
	for (;;) {
		const preds = (inAdj.get(ids[0]) ?? []).filter((p) => isUntagged(p) && !inPath.has(p));
		if (preds.length !== 1) break;
		const p = preds[0];
		ids.unshift(p);
		inPath.add(p);
		start -= lenOf(p);
		bp += lenOf(p);
	}
	// Append: a single untagged successor of the current last segment.
	for (;;) {
		const last = ids[ids.length - 1];
		const succs = (outAdj.get(last) ?? []).filter((s) => isUntagged(s) && !inPath.has(s));
		if (succs.length !== 1) break;
		const s = succs[0];
		ids.push(s);
		inPath.add(s);
		bp += lenOf(s);
	}

	const steps: Step[] = ids.map((id) => ({ id, orient: '+' }));
	return { steps, bp, contig: bestContig, start: Math.max(0, start) };
}
