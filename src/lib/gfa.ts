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
	/** Read depth / coverage from an assembler's tag: `dp:f` (average k-mer depth,
	 * a multiplier), or `KC:i`/`RC:i` (k-mer / read counts). Absent on pangenome
	 * graphs. Paired with {@link depthUnit} so the viewer can label it correctly. */
	depth?: number;
	depthUnit?: 'x' | 'reads';
	/** rGFA stable-sequence tags (minigraph): the reference contig name (`SN`), the
	 * 0-based offset on it (`SO`), and the stable rank (`SR`; 0 = the reference).
	 * When present these give a *real* reference backbone — no path/walk needed. */
	stableName?: string;
	stableOffset?: number;
	rank?: number;
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

/**
 * Where a `Walk` came from, so the viewer can label it honestly:
 *  - `'W'` — a GFA 1.1 W-line (a named haplotype traversal).
 *  - `'P'` — a GFA 1.0 P-line (a named path). Older graphs (odgi, vg, seqwish,
 *    minigraph) carry their samples as P-lines, not W-lines; we fold them into
 *    the same `Walk` shape so every downstream view (backbone pick, coordinates,
 *    tracing) works unchanged. A P-line has only a single name, so `sample` and
 *    `seqId` are both that name and `hapIndex` is 0.
 *  - `'synthetic'` — not from the file at all: a longest-path backbone the viewer
 *    computes when a graph has neither W- nor P-lines, so the reference-anchored
 *    layout still has an axis to hang variation off. Always flagged so the UI can
 *    say "this backbone was computed, it isn't a reference in your file".
 */
export type WalkKind = 'W' | 'P' | 'synthetic';

/** A haplotype traversal (GFA W-line), a named path (P-line), or a computed
 * backbone — all normalised to one shape. See {@link WalkKind}. */
export interface Walk {
	sample: string;
	hapIndex: number;
	seqId: string;
	start: number;
	end: number;
	steps: Step[];
	/** Optional tags on the W-line, e.g. WT:i:<copies> from --distinct. */
	tags: Record<string, string>;
	/** Origin of this traversal — W-line, P-line, or a computed backbone. Defaults
	 * to `'W'` when omitted (so existing W-only code paths are unaffected). */
	kind?: WalkKind;
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
	/**
	 * Haplotypes traversing this locus (reference + haplotypes), summing the `WT`
	 * weights of the reducer's `W` records. This is the count to show a user.
	 */
	totalWalks: number;
	/** Non-reference haplotypes (the ones aggregated into coverage tags). */
	nonRefWalks: number;
	/**
	 * Distinct sample names seen on `W` lines. GBZ-base anonymises haplotype
	 * walks when it extracts a subgraph, so for any graph served from a `.gbz.db`
	 * this is always 2 (the reference plus `unknown`) regardless of panel size —
	 * not a meaningful number, and deliberately not surfaced in the UI.
	 */
	samples: number;
	/**
	 * `W` records the reducer read, before weighting. At repetitive loci one
	 * haplotype is split into many traversal fragments, so this can be orders of
	 * magnitude larger than `totalWalks` — a structure diagnostic, not a count of
	 * haplotypes.
	 */
	walkRecords: number;
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

/** Reads a float GFA tag like `dp:f:37.5` from a line's trailing fields. */
function floatTag(fields: string[], tag: string): number | undefined {
	const prefix = `${tag}:f:`;
	for (const f of fields) {
		if (f.startsWith(prefix)) {
			const n = Number(f.slice(prefix.length));
			return Number.isFinite(n) ? n : undefined;
		}
	}
	return undefined;
}

/** Read depth from whichever assembler tag a segment carries: `dp:f` (a depth
 * multiplier, shown as "×"), else `KC:i`/`RC:i` (k-mer / read counts). */
function readDepth(fields: string[]): { depth: number; depthUnit: 'x' | 'reads' } | undefined {
	const dp = floatTag(fields, 'dp');
	if (dp !== undefined) return { depth: dp, depthUnit: 'x' };
	const kc = intTag(fields, 'KC') ?? intTag(fields, 'RC');
	if (kc !== undefined) return { depth: kc, depthUnit: 'reads' };
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

/**
 * Parse a P-line's `SegmentNames` field: a comma-separated list where each token
 * is a segment id followed by a trailing orientation, e.g. `1+,3+,5-,6+`. This is
 * the GFA 1.0 spelling of a traversal — distinct from a W-line's `>`/`<`-prefixed
 * form (see {@link parseSteps}). Tokens without a valid orientation, and the `*`
 * placeholder, are skipped.
 */
function parsePathSteps(field: string): Step[] {
	const steps: Step[] = [];
	if (!field || field === '*') return steps;
	for (const tok of field.split(',')) {
		if (tok.length < 2) continue;
		const orient = tok[tok.length - 1];
		if (orient !== '+' && orient !== '-') continue;
		steps.push({ id: tok.slice(0, -1), orient });
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
					walkRecords: intTag(f, 'WR') ?? 0,
					totalSequenceBp: intTag(f, 'TS') ?? 0
				};
				break;
			}
			case 'S': {
				const tags = f.slice(3);
				// A segment's sequence may be elided as `*` (or absent) with the length
				// carried in an `LN:i` tag instead — how minigraph's rGFA and many
				// assembler GFAs (sequence kept in a side FASTA) store nodes. Fall back
				// to that tag so those graphs still get real node lengths, which the
				// backbone/longest-path/coordinate math all depend on.
				const rawSeq = f[2] ?? '';
				const hasSeq = rawSeq.length > 0 && rawSeq !== '*';
				const seq = hasSeq ? rawSeq : '';
				const length = hasSeq ? rawSeq.length : (intTag(tags, 'LN') ?? 0);
				const depth = readDepth(tags);
				segments.set(f[1], {
					id: f[1],
					seq,
					length,
					coverage: intTag(tags, 'WC'),
					walkStarts: intTag(tags, 'WS'),
					walkEnds: intTag(tags, 'WE'),
					members: stringTag(tags, 'MB')?.split(','),
					depth: depth?.depth,
					depthUnit: depth?.depthUnit,
					stableName: stringTag(tags, 'SN'),
					stableOffset: intTag(tags, 'SO'),
					rank: intTag(tags, 'SR')
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
					tags,
					kind: 'W'
				});
				break;
			}
			case 'P': {
				// GFA 1.0 path. A P-line has just a name (no sample/hap/seq split), so
				// map it onto a `Walk` with the name in both `sample` and `seqId`. Its
				// bp span isn't on the line — we fill `end` from the summed segment
				// lengths in a post-pass below, once every S-line has been read.
				const name = f[1] ?? '';
				walks.push({
					sample: name,
					hapIndex: 0,
					seqId: name,
					start: 0,
					end: 0,
					steps: parsePathSteps(f[2] ?? ''),
					tags: {},
					kind: 'P'
				});
				break;
			}
			default:
				break;
		}
	}

	// A P-line carries no genomic coordinates, so give each path a bp span equal to
	// the sequence it visits (segment lengths summed over its steps). This makes the
	// "reference span" readout and the backbone coordinate axis meaningful for a
	// path-based graph, matching what a W-line's SeqStart/SeqEnd would give.
	for (const w of walks) {
		if (w.kind !== 'P') continue;
		let bp = 0;
		for (const s of w.steps) bp += segments.get(s.id)?.length ?? 0;
		w.end = bp;
	}

	return { headers, segments, links, walks, referenceSamples, reduced };
}

export interface GfaStats {
	segments: number;
	links: number;
	walks: number;
	/** Sum of all segment lengths — every distinct bit of sequence in the subgraph. */
	totalSequenceBp: number;
	/**
	 * Distinct sample names on the subgraph's `W` lines.
	 *
	 * Unreliable for graphs served from a `.gbz.db`: gbz-base anonymises the
	 * haplotype walks during subgraph extraction, so this is always 2 (the
	 * reference plus `unknown`) whatever the panel size. Meaningful only for a
	 * GFA parsed with real sample names. Do not present it as a panel size.
	 */
	samples: number;
	/**
	 * Traversal fragments the reducer read. Equals `walks` at ordinary loci; at
	 * repetitive ones a single haplotype is broken into many fragments, so a much
	 * larger number here means "this locus is fragmented", not "more haplotypes".
	 * Null when the subgraph wasn't reduced.
	 */
	walkRecords: number | null;
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
		walkRecords: gfa.reduced ? gfa.reduced.walkRecords : null,
		referencePathBp: ref ? ref.end - ref.start : null
	};
}
