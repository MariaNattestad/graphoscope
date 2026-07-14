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
