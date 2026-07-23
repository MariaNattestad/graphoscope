// Minimal parser for the GFA (v1.1, with W-lines) that `gbz-base query` emits.
// Intentionally small — it exposes the graph as plain data so the visualization
// layer can be designed independently.

export type Orient = '+' | '-';

export interface Segment {
	id: string;
	seq: string;
	length: number;
	/** Distinct non-reference walks through this node (from a `WC` tag in the
	 * reduced GFA). Undefined in full GFA, where coverage is counted from walks. */
	coverage?: number;
	/** Non-reference walks that begin (`WS`) or end (`WE`) exactly at this node.
	 * A walk stopping inside the graph, rather than at the subgraph boundary or
	 * the far side of a bubble, is the tell for a fragmentary haplotype. */
	walkStarts?: number;
	walkEnds?: number;
	/** Original pangenome node ids this segment stands for (`MB` tag), set only
	 * for unchop-merged chains — whose own id (`u<first>`) exists nowhere in the
	 * source graph, so this is what makes them traceable back to it. */
	members?: string[];
}

export interface Link {
	from: string;
	fromOrient: Orient;
	to: string;
	toOrient: Orient;
	/** Distinct non-reference walks across this edge (from a `WC` tag). */
	coverage?: number;
}

export interface Step {
	id: string;
	orient: Orient;
}

/** A haplotype traversal (GFA W-line). */
export interface Walk {
	sample: string;
	hapIndex: number;
	seqId: string;
	start: number;
	end: number;
	steps: Step[];
	/** Optional tags on the W-line, e.g. WT:i:<copies> from --distinct. */
	tags: Record<string, string>;
}

/** Locus-level counts carried by the reduced GFA's `X` stats line, so the viewer
 * can report walk/site/collapse totals without ever seeing the dropped walks. */
export interface ReducedStats {
	segmentsBefore: number;
	segmentsAfter: number;
	linksBefore: number;
	linksAfter: number;
	sites: number;
	nodesRemoved: number;
	snpCount: number;
	basesRemoved: number;
	unchopMerges: number;
	/** All walks in the subgraph (reference + haplotypes), before aggregation. */
	totalWalks: number;
	/** Non-reference walks (the ones aggregated into coverage tags). */
	nonRefWalks: number;
	samples: number;
	totalSequenceBp: number;
}

export interface Gfa {
	headers: string[];
	segments: Map<string, Segment>;
	links: Link[];
	walks: Walk[];
	/** Reference sample names from the header RS tag, if present. */
	referenceSamples: string[];
	/** Present when parsed from a reduced GFA (server-side simplified + walk-counted). */
	reduced?: ReducedStats;
}

/** Reads a string GFA tag like `MB:Z:1,2,3` from a line's trailing fields. */
function stringTag(fields: string[], tag: string): string | undefined {
	const prefix = `${tag}:Z:`;
	for (const f of fields) if (f.startsWith(prefix)) return f.slice(prefix.length);
	return undefined;
}

/** Reads an integer GFA tag like `WC:i:42` from a line's trailing fields. */
function intTag(fields: string[], tag: string): number | undefined {
	const prefix = `${tag}:i:`;
	for (const f of fields) {
		if (f.startsWith(prefix)) {
			const n = Number(f.slice(prefix.length));
			return Number.isFinite(n) ? n : undefined;
		}
	}
	return undefined;
}

function parseSteps(walk: string): Step[] {
	const steps: Step[] = [];
	// A step is an orientation (`>`/`<`) followed by a segment id. The id is not
	// always numeric: the reduced GFA's unchop-merged chains have ids like `u1`,
	// so match any run of non-orientation, non-space characters, not just digits.
	const re = /([<>])([^<>\s]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(walk)) !== null) {
		steps.push({ id: m[2], orient: m[1] === '>' ? '+' : '-' });
	}
	return steps;
}

export function parseGfa(text: string): Gfa {
	const headers: string[] = [];
	const segments = new Map<string, Segment>();
	const links: Link[] = [];
	const walks: Walk[] = [];
	let referenceSamples: string[] = [];
	let reduced: ReducedStats | undefined;

	for (const line of text.split('\n')) {
		if (line.length === 0) continue;
		const f = line.split('\t');
		switch (f[0]) {
			case 'H': {
				headers.push(line);
				for (const tag of f.slice(1)) {
					if (tag.startsWith('RS:Z:')) {
						referenceSamples = tag.slice(5).split(' ').filter(Boolean);
					}
				}
				break;
			}
			case 'X': {
				// Reduced-GFA stats line (custom record emitted by `query --format reduced`).
				reduced = {
					segmentsBefore: intTag(f, 'SB') ?? 0,
					segmentsAfter: intTag(f, 'SA') ?? 0,
					linksBefore: intTag(f, 'LB') ?? 0,
					linksAfter: intTag(f, 'LA') ?? 0,
					sites: intTag(f, 'ST') ?? 0,
					nodesRemoved: intTag(f, 'NR') ?? 0,
					snpCount: intTag(f, 'SN') ?? 0,
					basesRemoved: intTag(f, 'BR') ?? 0,
					unchopMerges: intTag(f, 'UM') ?? 0,
					totalWalks: intTag(f, 'TW') ?? 0,
					nonRefWalks: intTag(f, 'NW') ?? 0,
					samples: intTag(f, 'NS') ?? 0,
					totalSequenceBp: intTag(f, 'TS') ?? 0
				};
				break;
			}
			case 'S': {
				const seq = f[2] ?? '';
				const tags = f.slice(3);
				segments.set(f[1], {
					id: f[1],
					seq,
					length: seq.length,
					coverage: intTag(tags, 'WC'),
					walkStarts: intTag(tags, 'WS'),
					walkEnds: intTag(tags, 'WE'),
					members: stringTag(tags, 'MB')?.split(',')
				});
				break;
			}
			case 'L': {
				links.push({
					from: f[1],
					fromOrient: f[2] as Orient,
					to: f[3],
					toOrient: f[4] as Orient,
					coverage: intTag(f.slice(5), 'WC')
				});
				break;
			}
			case 'W': {
				const tags: Record<string, string> = {};
				for (const tag of f.slice(7)) {
					const parts = tag.split(':');
					if (parts.length >= 3) tags[parts[0]] = parts.slice(2).join(':');
				}
				walks.push({
					sample: f[1],
					hapIndex: Number(f[2]),
					seqId: f[3],
					start: Number(f[4]),
					end: Number(f[5]),
					steps: parseSteps(f[6] ?? ''),
					tags
				});
				break;
			}
			default:
				break;
		}
	}

	return { headers, segments, links, walks, referenceSamples, reduced };
}

export interface GfaStats {
	segments: number;
	links: number;
	walks: number;
	/** Sum of all segment lengths — every distinct bit of sequence in the subgraph. */
	totalSequenceBp: number;
	samples: number;
	/** bp spanned by the reference walk (its own W-line start/end), or null if
	 * `referenceSample` wasn't given or has no walk in this subgraph. Distinct
	 * from `totalSequenceBp`: it's just the reference's own genomic span, not
	 * every haplotype's sequence combined. */
	referencePathBp: number | null;
}

export function gfaStats(gfa: Gfa, referenceSample?: string): GfaStats {
	let totalSequenceBp = 0;
	for (const s of gfa.segments.values()) totalSequenceBp += s.length;
	const ref = referenceSample ? gfa.walks.find((w) => w.sample === referenceSample) : undefined;
	// In reduced mode the non-reference walks have been aggregated away, so the
	// live `walks`/sample counts would undercount — use the totals the reducer
	// recorded on the `X` line instead.
	const walks = gfa.reduced ? gfa.reduced.totalWalks : gfa.walks.length;
	const samples = gfa.reduced ? gfa.reduced.samples : new Set(gfa.walks.map((w) => w.sample)).size;
	return {
		segments: gfa.segments.size,
		links: gfa.links.length,
		walks,
		totalSequenceBp,
		samples,
		referencePathBp: ref ? ref.end - ref.start : null
	};
}
