// Minimal parser for the GFA (v1.1, with W-lines) that `gbz-base query` emits.
// Intentionally small — it exposes the graph as plain data so the visualization
// layer can be designed independently.

export type Orient = '+' | '-';

export interface Segment {
	id: string;
	seq: string;
	length: number;
}

export interface Link {
	from: string;
	fromOrient: Orient;
	to: string;
	toOrient: Orient;
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

export interface Gfa {
	headers: string[];
	segments: Map<string, Segment>;
	links: Link[];
	walks: Walk[];
	/** Reference sample names from the header RS tag, if present. */
	referenceSamples: string[];
}

function parseSteps(walk: string): Step[] {
	const steps: Step[] = [];
	const re = /([<>])(\d+)/g;
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
			case 'S': {
				const seq = f[2] ?? '';
				segments.set(f[1], { id: f[1], seq, length: seq.length });
				break;
			}
			case 'L': {
				links.push({
					from: f[1],
					fromOrient: f[2] as Orient,
					to: f[3],
					toOrient: f[4] as Orient
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

	return { headers, segments, links, walks, referenceSamples };
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
	const samples = new Set(gfa.walks.map((w) => w.sample));
	const ref = referenceSample ? gfa.walks.find((w) => w.sample === referenceSample) : undefined;
	return {
		segments: gfa.segments.size,
		links: gfa.links.length,
		walks: gfa.walks.length,
		totalSequenceBp,
		samples: samples.size,
		referencePathBp: ref ? ref.end - ref.start : null
	};
}

/**
 * Same output shape as `gfaStats(parseGfa(text))`, but without ever building a
 * `Gfa` object: no `segments` Map, no `Link[]`, and critically no per-step
 * `Step` objects for every walk (parseGfa's `parseSteps` regex is what turns a
 * huge/repetitive locus into millions of tiny objects and crashes the tab).
 * This only reads the handful of fixed fields at the front of each line —
 * for W-lines that means stopping before the walk-string field entirely, so
 * a walk with thousands of steps costs the same as one with a handful.
 * Used as the final fallback for a locus too large to parse/render at all.
 */
export function gfaLightStats(text: string): GfaStats {
	let segments = 0;
	let links = 0;
	let walks = 0;
	let totalSequenceBp = 0;
	const samples = new Set<string>();

	const n = text.length;
	let i = 0;
	while (i < n) {
		let eol = text.indexOf('\n', i);
		if (eol === -1) eol = n;
		if (eol > i) {
			const tag = text.charCodeAt(i);
			if (tag === 83 /* 'S' */) {
				segments++;
				// S <id> <seq> — seq is everything after the 2nd tab.
				const t1 = text.indexOf('\t', i + 2);
				const t2 = t1 === -1 ? -1 : text.indexOf('\t', t1 + 1);
				if (t1 !== -1) totalSequenceBp += (t2 === -1 || t2 > eol ? eol : t2) - (t1 + 1);
			} else if (tag === 76 /* 'L' */) {
				links++;
			} else if (tag === 87 /* 'W' */) {
				walks++;
				// W <sample> <hapIndex> <seqId> <start> <end> <walk-string...>
				// The sample field runs from i+2 (right after "W\t") up to the
				// tab that terminates it — never touch the walk-string field.
				const t1 = text.indexOf('\t', i + 2);
				if (t1 !== -1 && t1 <= eol) samples.add(text.slice(i + 2, t1));
			}
		}
		i = eol + 1;
	}

	return { segments, links, walks, totalSequenceBp, samples: samples.size };
}

/**
 * Drops every W-line except the reference sample's, keeping every other line
 * (headers, segments, links) untouched. This is a client-side equivalent of
 * `query`'s `--reference-only` flag: on a large or repetitive locus, haplotype
 * walks dominate GFA size (measured ~97% of bytes on a real large locus), not
 * sequence or topology — segments/links are determined by the query interval,
 * not by which walks reference them, so filtering after the fact produces the
 * same result as asking the query tool to skip non-reference walks in the
 * first place (confirmed byte-for-byte against a real `--reference-only`
 * response). Doing this locally means an oversized query's already-fetched
 * response can be downsized without paying for a second round-trip query.
 *
 * Only ever holds the lines being kept in memory, not the discarded walks — a
 * dropped W-line's (potentially huge) walk-string is never even sliced out.
 */
export function filterToReferenceWalks(text: string, referenceSample: string): string {
	const out: string[] = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		let eol = text.indexOf('\n', i);
		if (eol === -1) eol = n;
		if (eol > i) {
			if (text.charCodeAt(i) === 87 /* 'W' */) {
				// W <sample> <hapIndex> ... — only the sample field decides keep/drop.
				const t1 = text.indexOf('\t', i + 2);
				const sample = t1 !== -1 && t1 <= eol ? text.slice(i + 2, t1) : '';
				if (sample === referenceSample) out.push(text.slice(i, eol));
			} else {
				out.push(text.slice(i, eol));
			}
		}
		i = eol + 1;
	}
	return out.join('\n') + '\n';
}
