// Structural metrics for an assembly-style GFA — the numbers you actually want
// for a reference-less graph (SPAdes / Flye / Unicycler / hifiasm / minigraph),
// which the locus browser's "walks / samples" readout says nothing about:
// contig N50, connected components, dead-ends (tips), self-loops, and — when the
// assembler wrote depth tags — a depth summary. All computed straight from the
// parsed segments and links, no layout required.

import type { Gfa } from '../gfa';

export interface DepthSummary {
	/** How depth was reported: a `dp:f` multiplier ("×") or `KC`/`RC` counts. */
	unit: 'x' | 'reads';
	min: number;
	median: number;
	max: number;
	/** How many segments carried a depth tag (the rest are excluded from the stats). */
	covered: number;
}

export interface AssemblyStats {
	segments: number;
	links: number;
	totalBp: number;
	/** Segment-length N50: the length L such that segments ≥ L cover half the total bp. */
	n50: number;
	/** Number of connected components (links treated as undirected). */
	components: number;
	/** Fraction of segments in the largest component (1 = one connected graph). */
	largestComponentFraction: number;
	/** Segments with a free end (a `+`/`-` side no link attaches to) — assembly tips.
	 * Fully isolated segments (both ends free, no links) are counted separately. */
	deadEnds: number;
	isolated: number;
	/** Links from a segment back to itself. */
	selfLoops: number;
	/** Present only when the graph carries depth tags. */
	depth: DepthSummary | null;
}

/** Which physical end of a segment a link attaches to. A `+` orientation uses the
 * segment's forward (right) end at the `from` side and its start (left) end at the
 * `to` side; `-` flips each. Encodes both ends of a link as touched. */
function markEnds(
	fromId: string,
	fromOrient: '+' | '-',
	toId: string,
	toOrient: '+' | '-',
	right: Set<string>,
	left: Set<string>
) {
	// from: '+' leaves by its right end, '-' by its left end.
	if (fromOrient === '+') right.add(fromId);
	else left.add(fromId);
	// to: '+' is entered at its left end, '-' at its right end.
	if (toOrient === '+') left.add(toId);
	else right.add(toId);
}

function n50(lengths: number[], totalBp: number): number {
	if (lengths.length === 0) return 0;
	const sorted = [...lengths].sort((a, b) => b - a);
	let acc = 0;
	for (const len of sorted) {
		acc += len;
		if (acc * 2 >= totalBp) return len;
	}
	return sorted[sorted.length - 1];
}

export function computeAssemblyStats(gfa: Gfa): AssemblyStats {
	const segments = [...gfa.segments.values()];
	const n = segments.length;

	let totalBp = 0;
	const lengths: number[] = [];
	const depths: number[] = [];
	let depthUnit: 'x' | 'reads' | null = null;
	for (const s of segments) {
		totalBp += s.length;
		lengths.push(s.length);
		if (s.depth !== undefined) {
			depths.push(s.depth);
			depthUnit = s.depthUnit ?? depthUnit;
		}
	}

	// Union-find over undirected links → connected components.
	const parent = new Map<string, string>();
	for (const s of segments) parent.set(s.id, s.id);
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r)!;
		// Path compression.
		while (parent.get(x) !== r) {
			const nx = parent.get(x)!;
			parent.set(x, r);
			x = nx;
		}
		return r;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	// Track which ends carry a link, and count self-loops, in one pass.
	const rightUsed = new Set<string>();
	const leftUsed = new Set<string>();
	let selfLoops = 0;
	for (const l of gfa.links) {
		if (!gfa.segments.has(l.from) || !gfa.segments.has(l.to)) continue;
		if (l.from === l.to) selfLoops++;
		union(l.from, l.to);
		markEnds(l.from, l.fromOrient, l.to, l.toOrient, rightUsed, leftUsed);
	}

	// Component sizes.
	const compSize = new Map<string, number>();
	for (const s of segments) {
		const r = find(s.id);
		compSize.set(r, (compSize.get(r) ?? 0) + 1);
	}
	let largest = 0;
	for (const size of compSize.values()) if (size > largest) largest = size;

	// Dead-ends (a free end) vs. isolated (both ends free / no links at all).
	let deadEnds = 0;
	let isolated = 0;
	for (const s of segments) {
		const hasL = leftUsed.has(s.id);
		const hasR = rightUsed.has(s.id);
		if (!hasL && !hasR) isolated++;
		else if (!hasL || !hasR) deadEnds++;
	}

	let depth: DepthSummary | null = null;
	if (depths.length > 0 && depthUnit) {
		const sorted = [...depths].sort((a, b) => a - b);
		const median = sorted[Math.floor((sorted.length - 1) / 2)];
		depth = {
			unit: depthUnit,
			min: sorted[0],
			median,
			max: sorted[sorted.length - 1],
			covered: depths.length
		};
	}

	return {
		segments: n,
		links: gfa.links.length,
		totalBp,
		n50: n50(lengths, totalBp),
		components: compSize.size,
		largestComponentFraction: n > 0 ? largest / n : 0,
		deadEnds,
		isolated,
		selfLoops,
		depth
	};
}
