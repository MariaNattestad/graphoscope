// Gene models (exon structure, not just start/end) for the locus being viewed.
//
// These come from UCSC's bigBed gene tracks, read over HTTP range requests —
// the same trick the pangenome database itself uses, so a locus costs a few KB
// rather than downloading a whole annotation. Both files send
// `Access-Control-Allow-Origin: *` and support ranges, and bigBed carries its
// own R-tree index, so no server of ours is involved.
//
// This is the single source for the gene track: bodies AND exons come from
// here. Mixing sources — gene bounds from the bundled symbol maps, exons from
// UCSC — risks drawing a gene body that disagrees with the exons inside it.
// The bundled maps stay in use for the locus-search autocomplete, where only
// symbol -> coordinate matters.

import { BigBed } from '@gmod/bbi';
import type { RefKey } from './genes';

/** One transcript's structure, in reference coordinates. */
export interface Transcript {
	/** Transcript accession, e.g. ENST00000380707.8 or NM_001297715.1. */
	name: string;
	/** Gene symbol, e.g. SMN1. */
	symbol: string;
	strand: '+' | '-';
	start: number;
	end: number;
	/** Coding span; equal to each other when the transcript is non-coding. */
	cdsStart: number;
	cdsEnd: number;
	exons: { start: number; end: number }[];
}

// hg38's knownGene is GENCODE-derived and CHM13's is the RefSeq liftover —
// matching what the bundled symbol maps are built from for each assembly.
const SOURCES: Record<RefKey, string> = {
	grch38: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/knownGene.bb',
	chm13: 'https://hgdownload.soe.ucsc.edu/gbdb/hs1/ncbiRefSeq/ncbiRefSeqCurated.bb'
};

const readers = new Map<RefKey, BigBed>();
function reader(ref: RefKey): BigBed {
	let r = readers.get(ref);
	if (!r) {
		r = new BigBed({ url: SOURCES[ref] });
		readers.set(ref, r);
	}
	return r;
}

/**
 * Field order differs between the two files — CHM13's carries the symbol in
 * `name2`, hg38's in `geneName` — so read it from each file's own autoSql
 * declaration instead of hardcoding positions. The first three columns
 * (chrom/start/end) are consumed by the reader, so `rest` begins at column 3.
 */
function fieldIndex(autoSql: string | undefined): Map<string, number> {
	const map = new Map<string, number>();
	if (!autoSql) return map;
	let i = 0;
	for (const line of autoSql.split('\n')) {
		const m = line.trim().match(/^\w[\w[\]]*\s+(\w+)\s*;/);
		if (!m) continue;
		if (i >= 3) map.set(m[1], i - 3);
		i++;
	}
	return map;
}

const num = (s: string | undefined) => {
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
};
const list = (s: string | undefined) =>
	(s ?? '')
		.split(',')
		.filter((x) => x !== '')
		.map(Number);

/** Transcripts overlapping a window, with exon structure. */
export async function transcriptsInRange(
	ref: RefKey,
	contig: string,
	start: number,
	end: number
): Promise<Transcript[]> {
	const bb = reader(ref);
	const header = await bb.getHeader();
	const idx = fieldIndex(header.autoSql);
	const at = (f: string[], name: string, fallback: number) => f[idx.get(name) ?? fallback];

	const feats = await bb.getFeatures(contig, start, end);
	const out: Transcript[] = [];
	for (const feat of feats) {
		const f = String(feat.rest ?? '').split('\t');
		const name = at(f, 'name', 0) ?? '';
		// Prefer an actual symbol over a repeated accession.
		const candidates = [at(f, 'geneName', 14), at(f, 'name2', 9)].filter(
			(v): v is string => !!v && v !== name && v !== 'none'
		);
		const symbol = candidates[0] ?? name;

		const sizes = list(at(f, 'blockSizes', 7));
		const starts = list(at(f, 'chromStarts', 8));
		const exons: Transcript['exons'] = [];
		for (let i = 0; i < Math.min(sizes.length, starts.length); i++) {
			exons.push({ start: feat.start + starts[i], end: feat.start + starts[i] + sizes[i] });
		}

		out.push({
			name,
			symbol,
			strand: at(f, 'strand', 2) === '-' ? '-' : '+',
			start: feat.start,
			end: feat.end,
			cdsStart: num(at(f, 'thickStart', 3)),
			cdsEnd: num(at(f, 'thickEnd', 4)),
			exons
		});
	}
	return out;
}

/**
 * One transcript per gene symbol, so a gene with a dozen isoforms doesn't fill
 * the track. Prefers the longest coding span, falling back to the longest
 * overall — a reasonable stand-in for "canonical" without another lookup.
 */
export function representativeTranscripts(transcripts: Transcript[]): Transcript[] {
	const best = new Map<string, Transcript>();
	for (const t of transcripts) {
		const prev = best.get(t.symbol);
		if (!prev) {
			best.set(t.symbol, t);
			continue;
		}
		const score = (x: Transcript) => [x.cdsEnd - x.cdsStart, x.end - x.start];
		const [ac, al] = score(t);
		const [bc, bl] = score(prev);
		if (ac > bc || (ac === bc && al > bl)) best.set(t.symbol, t);
	}
	return [...best.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
