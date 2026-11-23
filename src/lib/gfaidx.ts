// The /gfaidx page's pure helpers: what a gfaidx index is made of, which of its
// paths a region can be asked on, and how its answer becomes the GFA the rest
// of Graphoscope reads.
//
// gfaidx (Dabbaghie & Steinegger, https://github.com/fawaz-dabbaghieh/gfaidx)
// indexes a GFA for random access. What it gives Graphoscope that GBZ-base does
// not is names: every walk in a region comes back as the haplotype it belongs
// to, with its own coordinates, instead of an anonymous walk.

import type { RefKey } from './genes';

/** The files of a gfaidx index, each named by appending its suffix to the graph's
 * URL. A region query needs the path index and node lengths too. `.cdx` is the
 * coordinate index of an rGFA graph (minigraph), which has no paths: it is only
 * looked for when there is no `.pdx`, so an ordinary index is not asked for a
 * file it doesn't have. */
export const INDEX_SIDECARS: { suffix: string; required: boolean; what: string; insteadOf?: string }[] = [
	{ suffix: '', required: true, what: 'the graph, one gzip member per community of nodes' },
	{ suffix: '.idx', required: true, what: 'byte offset of each community' },
	{ suffix: '.ndx', required: true, what: 'node name → node id' },
	{ suffix: '.pdx', required: false, what: 'paths and walks, by path and by node' },
	{ suffix: '.lnx', required: false, what: 'node lengths' },
	{ suffix: '.pcx', required: false, what: 'coordinate checkpoints along each path' },
	{ suffix: '.cdx', required: false, what: 'rGFA reference coordinates', insteadOf: '.pdx' }
];

/** A path or walk of the index that a region can be asked on. */
export interface IndexTrack {
	/** `P` (a GFA path), `W` (a walk) or `S` (an rGFA reference track). */
	type: string;
	sample: string;
	haplotype: number;
	/** The contig within the sample, e.g. chr21. */
	contig: string;
	/** `sample#haplotype#contig`: how the track is named in links and in the picker. */
	name: string;
	/** What gfaidx is told: `--reference` and `--sequence`. */
	reference: string;
	sequence: string;
	steps: number;
}

/** `sample#haplotype#contig` (PanSN) → its parts. A name with fewer parts is a
 * sample with one contig named after it. */
export function parsePanSn(name: string): { sample: string; haplotype: number; contig: string } {
	const parts = name.split('#');
	if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
		return { sample: parts[0], haplotype: Number(parts[1]), contig: parts.slice(2).join('#') };
	}
	if (parts.length === 2) return { sample: parts[0], haplotype: 0, contig: parts[1] };
	return { sample: name, haplotype: 0, contig: name };
}

/** A path name's `:start-end` suffix, which gfaidx reads as "this path is that
 * stretch of a longer sequence". */
const FRAGMENT = /^(.*):(\d+)-(\d+)$/;

/** The table `gfaidx-query tracks` writes → the tracks a region can be asked on,
 * one per sequence (a path cut into fragments is one track). */
export function parseTracks(tsv: string): IndexTrack[] {
	const tracks: IndexTrack[] = [];
	const seen = new Set<string>();
	for (const line of tsv.split('\n')) {
		if (!line) continue;
		const f = line.split('\t');
		if (f.length < 7) continue;
		const type = f[0];
		let track: IndexTrack;
		if (type === 'P') {
			const full = FRAGMENT.exec(f[3])?.[1] ?? f[3];
			const { sample, haplotype, contig } = parsePanSn(full);
			track = { type, sample, haplotype, contig, name: full, reference: '', sequence: full, steps: Number(f[6]) };
		} else {
			const sample = f[1];
			const haplotype = Number(f[2]);
			track = {
				type,
				sample,
				haplotype,
				contig: f[3],
				name: `${sample}#${haplotype}#${f[3]}`,
				reference: sample,
				sequence: f[3],
				steps: Number(f[6])
			};
		}
		const key = `${track.reference}\t${track.sequence}`;
		if (seen.has(key)) continue;
		seen.add(key);
		tracks.push(track);
	}
	return tracks;
}

/** Samples that are a linear reference, not an assembly of a person. */
const REFERENCE_SAMPLE = /^(chm13|t2t|grch3[78]|hg(19|38)|hs1)/i;

export function isReferenceTrack(t: IndexTrack): boolean {
	return REFERENCE_SAMPLE.test(t.sample);
}

/** Which gene set and gene track fit a track's coordinates, if any. */
export function refKeyFor(t: IndexTrack | null): RefKey | undefined {
	if (!t) return undefined;
	if (/^(chm13|t2t|hs1)/i.test(t.sample)) return 'chm13';
	if (/^(grch38|hg38)/i.test(t.sample)) return 'grch38';
	return undefined;
}

/** The track a link's `path=` names: a full name, a sample (its first track, or
 * its track on `contig`), or nothing (the first reference, else the first track). */
export function pickTrack(tracks: IndexTrack[], path: string | null, contig?: string): IndexTrack | null {
	if (tracks.length === 0) return null;
	const onContig = (list: IndexTrack[]) => (contig ? (list.find((t) => t.contig === contig) ?? null) : null);
	if (path) {
		const want = path.trim().toLowerCase();
		const exact = tracks.find((t) => t.name.toLowerCase() === want);
		if (exact && (!contig || exact.contig === contig)) return exact;
		const sample = exact ? exact.sample.toLowerCase() : want;
		const ofSample = tracks.filter((t) => t.sample.toLowerCase() === sample);
		return onContig(ofSample) ?? exact ?? ofSample[0] ?? null;
	}
	const references = tracks.filter(isReferenceTrack);
	return onContig(references) ?? onContig(tracks) ?? references[0] ?? tracks[0];
}

export interface RegionQuery {
	track: IndexTrack;
	/** 0-based, half-open, on the track's own coordinates. */
	start: number;
	end: number;
}

/** The flags `gfaidx-query region` takes for a query. */
export function regionArgs(q: RegionQuery): string[] {
	const args = [
		'--reference',
		q.track.reference,
		'--sequence',
		q.track.sequence,
		'--begin',
		String(Math.max(0, Math.round(q.start))),
		'--end',
		String(Math.round(q.end))
	];
	// Exactly the stretch each haplotype has between the interval's two ends.
	// gfaidx's other mode (bfs --context) only widened the window, at many times
	// the requests, and gave up on complex loci.
	args.push('--mode', 'all');
	return args;
}

/**
 * gfaidx's answer → GFA 1.1 with every traversal a named `W` line and the
 * queried sample declared as the reference (`RS:Z:`), which is the form
 * Graphoscope's Simplify and its walk tracing read.
 *
 * A graph indexed from `W` lines already comes back that way. One indexed from
 * `P` lines (PGGB, odgi) comes back as paths named `sample#hap#contig:start-end`;
 * each becomes the `W` line saying the same thing.
 */
export function toWalkGfa(text: string, referenceSample: string): { gfa: string; walks: number } {
	const out: string[] = [`H\tVN:Z:1.1\tRS:Z:${referenceSample}`];
	let walks = 0;
	for (const line of text.split('\n')) {
		if (!line) continue;
		switch (line[0]) {
			case 'H':
				break;
			case 'P': {
				const f = line.split('\t');
				const m = FRAGMENT.exec(f[1] ?? '');
				const { sample, haplotype, contig } = parsePanSn(m ? m[1] : (f[1] ?? ''));
				const steps = (f[2] ?? '')
					.split(',')
					.filter(Boolean)
					.map((s) => (s.endsWith('-') ? '<' : '>') + s.slice(0, -1))
					.join('');
				// Without coordinates the walk still needs a span: `*` is not legal
				// here, so it starts at 0 and the parser's length pass is not run.
				out.push(`W\t${sample}\t${haplotype}\t${contig}\t${m ? m[2] : 0}\t${m ? m[3] : 0}\t${steps}`);
				walks++;
				break;
			}
			case 'W':
				out.push(line);
				walks++;
				break;
			default:
				out.push(line);
		}
	}
	return { gfa: out.join('\n') + '\n', walks };
}

/** Demo indexes the page can open by name (`index=<id>`). */
export interface GfaidxExample {
	id: string;
	label: string;
	/** What it is, in a few words. */
	kind: string;
	/** Root-relative (bundled under static/) or absolute URL of the indexed graph. */
	url: string;
	/** A region worth opening first. */
	locus: string;
}
