// Shared computation: place non-reference nodes onto the reference coordinate
// system. Used by both the arc view and the IGV.js view.
import type { Gfa } from './gfa';

export interface NonRefEvent {
	id: string;
	len: number;
	/** Reference bp (relative to the subgraph reference path) where the alt anchors. */
	leftBp: number;
	rightBp: number;
	/** bp of reference spanned between the anchors (0 for a pure insertion). */
	skipped: number;
	/** len - skipped: >0 net insertion, <0 alt shorter than replaced ref. */
	net: number;
	/** Number of non-reference haplotype walks that traverse this node. */
	cov: number;
}

export interface NonRefModel {
	refName: string;
	contig: string;
	/** Genomic start (0-based) of the reference path fragment in this subgraph. */
	genomicStart: number;
	/** Reference path length in bp within the subgraph. */
	refLen: number;
	totalNonRef: number;
	events: NonRefEvent[];
	maxLen: number;
}

// --- shared classification + color scales (used by the arc view and IGV) ---

export type NetClass = 'insertion' | 'expansion' | 'contraction' | 'substitution';

/** Variant "size" for filtering/scaling: the bigger of inserted or deleted bp, so
 * a large deletion (small/zero alt allele, large skipped ref) isn't mistaken for
 * a tiny variant. */
export function eventSize(ev: { len: number; skipped: number }): number {
	return Math.max(ev.len, ev.skipped);
}

/** Classify a non-reference node by how its length compares to the reference it replaces. */
export function classify(ev: { skipped: number; net: number }): NetClass {
	if (ev.net === 0) return 'substitution';
	if (ev.net > 0) return ev.skipped === 0 ? 'insertion' : 'expansion';
	return 'contraction';
}

// Paired blues for insertions: dark = pure insertion (no ref replaced),
// light = net insertion that also replaces some reference sequence.
export const NET_COLORS: Record<NetClass, string> = {
	insertion: '#1d4ed8', // pure insertion (0 bp ref replaced)
	expansion: '#60a5fa', // net insertion, replaces some ref
	contraction: '#dc2626', // net deletion (alt shorter than replaced ref)
	substitution: '#6b7280' // same length
};

export const NET_LABELS: Record<NetClass, string> = {
	insertion: 'insertion (0 bp ref)',
	expansion: 'net insertion',
	contraction: 'net deletion',
	substitution: 'substitution'
};

/** Short code for compact labels (e.g. IGV feature names). */
export const NET_CODES: Record<NetClass, string> = {
	insertion: 'ins',
	expansion: 'ins*',
	contraction: 'del',
	substitution: 'sub'
};

// Coverage scale: the same yellow → red ramp the graph layout uses for walks
// through a node, so "how many walks carry this" reads identically in every
// view. (These are the HEATMAP_LOW/HIGH endpoints from graph/colors.ts, kept
// here as numbers because this module is imported by the plain-canvas views.)
export function coverageRgb(cov: number, total: number): [number, number, number] {
	const t = total <= 1 ? 0 : Math.min(1, Math.max(0, (cov - 1) / (total - 1)));
	const lo: [number, number, number] = [255, 214, 10]; // yellow: few walks
	const hi: [number, number, number] = [214, 30, 30]; // red: many walks
	return [
		Math.round(lo[0] + (hi[0] - lo[0]) * t),
		Math.round(lo[1] + (hi[1] - lo[1]) * t),
		Math.round(lo[2] + (hi[2] - lo[2]) * t)
	];
}

export function coverageColor(cov: number, total: number): string {
	const [r, g, b] = coverageRgb(cov, total);
	return `rgb(${r},${g},${b})`;
}

export function computeNonRefNodes(
	gfa: Gfa,
	referenceSample: string,
	minLen: number
): NonRefModel | null {
	const ref = gfa.walks.find((w) => w.sample === referenceSample) ?? gfa.walks[0];
	if (!ref) return null;

	// Reference node -> [start,end) bp along the reference path.
	const refCoord = new Map<string, { start: number; end: number }>();
	let off = 0;
	for (const s of ref.steps) {
		const len = gfa.segments.get(s.id)?.length ?? 0;
		refCoord.set(s.id, { start: off, end: off + len });
		off += len;
	}
	const refLen = Math.max(1, off);

	// Undirected adjacency from links.
	const adj = new Map<string, Set<string>>();
	const add = (a: string, b: string) => {
		let s = adj.get(a);
		if (!s) adj.set(a, (s = new Set()));
		s.add(b);
	};
	for (const l of gfa.links) {
		add(l.from, l.to);
		add(l.to, l.from);
	}

	// Coverage: non-reference walks that traverse each node. In reduced mode this
	// is precomputed (segment.coverage from the `WC` tag) because the walks were
	// aggregated away; otherwise count it from the walks in hand.
	const isReduced = gfa.reduced !== undefined;
	const nonRefWalks = gfa.walks.filter((w) => w !== ref);
	const cov = new Map<string, number>();
	if (isReduced) {
		for (const s of gfa.segments.values()) if (s.coverage !== undefined) cov.set(s.id, s.coverage);
	} else {
		for (const w of nonRefWalks) {
			for (const step of w.steps) cov.set(step.id, (cov.get(step.id) ?? 0) + 1);
		}
	}
	const totalNonRef = Math.max(1, isReduced ? (gfa.reduced?.nonRefWalks ?? 0) : nonRefWalks.length);

	function nearestRef(startId: string): { start: number; end: number } | null {
		const seen = new Set([startId]);
		let frontier = [startId];
		for (let d = 0; d < 8 && frontier.length; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const nb of adj.get(id) ?? []) {
					const rc = refCoord.get(nb);
					if (rc) return rc;
					if (!seen.has(nb)) {
						seen.add(nb);
						next.push(nb);
					}
				}
			}
			frontier = next;
		}
		return null;
	}

	const events: NonRefEvent[] = [];
	for (const seg of gfa.segments.values()) {
		if (refCoord.has(seg.id)) continue;
		const refNbrs = [...(adj.get(seg.id) ?? [])]
			.map((n) => refCoord.get(n))
			.filter((c): c is { start: number; end: number } => !!c);

		let leftBp: number, rightBp: number;
		if (refNbrs.length === 1) {
			leftBp = rightBp = refNbrs[0].end;
		} else if (refNbrs.length > 1) {
			refNbrs.sort((a, b) => a.start - b.start);
			leftBp = refNbrs[0].end;
			rightBp = refNbrs[refNbrs.length - 1].start;
			if (rightBp < leftBp) [leftBp, rightBp] = [rightBp, leftBp];
		} else {
			const near = nearestRef(seg.id);
			if (!near) continue;
			leftBp = rightBp = near.end;
		}
		const skipped = Math.max(0, rightBp - leftBp);
		// Size a variant by whichever is bigger: the inserted (alt) bp or the
		// deleted (skipped reference) bp. A deletion's alt allele is often a tiny
		// residual segment, so filtering on seg.length alone would hide large
		// deletions entirely.
		if (Math.max(seg.length, skipped) <= minLen) continue;
		events.push({
			id: seg.id,
			len: seg.length,
			leftBp,
			rightBp,
			skipped,
			net: seg.length - skipped,
			cov: cov.get(seg.id) ?? 0
		});
	}

	// Pure deletions with no alt segment at all: a link directly between two
	// reference nodes that skips over one or more reference nodes in between. Edge
	// coverage comes from the reduced GFA's per-link `WC` tag, or (full GFA) from
	// counting non-reference walk step-pairs.
	const nonRefPairCount = new Map<string, number>();
	if (!isReduced) {
		for (const w of nonRefWalks) {
			for (let i = 0; i + 1 < w.steps.length; i++) {
				const a = w.steps[i].id;
				const b = w.steps[i + 1].id;
				if (a === b) continue;
				const k = `${a}>${b}`;
				nonRefPairCount.set(k, (nonRefPairCount.get(k) ?? 0) + 1);
			}
		}
	}
	const seenSkip = new Set<string>();
	for (const l of gfa.links) {
		const a = refCoord.get(l.from);
		const b = refCoord.get(l.to);
		if (!a || !b) continue;
		const [left, right] = a.start <= b.start ? [a, b] : [b, a];
		const skipped = right.start - left.end;
		if (skipped <= 0) continue; // adjacent reference nodes, not a deletion
		if (Math.max(0, skipped) <= minLen) continue;
		const key = a.start <= b.start ? `${l.from}>${l.to}` : `${l.to}>${l.from}`;
		if (seenSkip.has(key)) continue;
		seenSkip.add(key);
		const edgeCov = isReduced
			? (l.coverage ?? 0)
			: (nonRefPairCount.get(`${l.from}>${l.to}`) ?? 0) + (nonRefPairCount.get(`${l.to}>${l.from}`) ?? 0);
		events.push({
			id: `del:${l.from}>${l.to}`,
			len: 0,
			leftBp: left.end,
			rightBp: right.start,
			skipped,
			net: -skipped,
			cov: edgeCov
		});
	}
	events.sort((a, b) => a.leftBp - b.leftBp);
	// "Size" for scaling: the bigger of inserted or deleted bp, so a deletion
	// (len=0, large skipped) scales the same as an insertion of the same impact.
	const maxLen = Math.max(1, ...events.map((e) => Math.max(e.len, e.skipped)));
	return {
		refName: `${ref.sample}#${ref.hapIndex}#${ref.seqId}`,
		contig: ref.seqId,
		genomicStart: ref.start,
		refLen,
		totalNonRef,
		events,
		maxLen
	};
}
