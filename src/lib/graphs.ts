// The two hosted graphs, shared between the interactive page and the machine-
// readable /api route so a coordinate means the same thing in both.
//
// Both are HPRC Release 2 (v2.1) Minigraph-Cactus pangenome graphs. We serve the
// public GBZ-base `.gbz.db` (SQLite) files straight from the human-pangenomics
// AWS Open Data bucket, which sends `Access-Control-Allow-Origin: *` and HTTP
// range support so the browser can query a locus without downloading the multi-GB
// database. Measured ~2x faster per range request than proxying the same objects
// through 42basepairs (`/download/s3/…`), which added ~1s of latency per request
// with no edge caching — and each locus query makes many serial range requests,
// so that per-request cost dominates the fetch time.

import type { RefKey } from './genes';

export const DB_BASE =
	'https://human-pangenomics.s3.amazonaws.com/pangenomes/freeze/release2/minigraph-cactus/v2.1';

export interface GraphDef {
	id: 'grch38' | 'chm13';
	label: string;
	/** Reference sample name inside the graph — also the coordinate system. */
	referenceSample: string;
	/** Which bundled gene map matches this reference. */
	refKey: RefKey;
	dbUrl: string;
	/** Original public source we indexed. */
	s3Source: string;
}

export const GRAPHS: GraphDef[] = [
	{
		id: 'grch38',
		label: 'GRCh38-based',
		referenceSample: 'GRCh38',
		refKey: 'grch38',
		dbUrl: `${DB_BASE}/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db`,
		s3Source:
			's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz'
	},
	{
		id: 'chm13',
		label: 'CHM13-based (T2T)',
		referenceSample: 'CHM13',
		refKey: 'chm13',
		dbUrl: `${DB_BASE}/hprc-v2.1-mc-chm13/hprc-v2.1-mc-chm13.gbz.db`,
		s3Source:
			's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-chm13/hprc-v2.1-mc-chm13.gbz'
	}
];

export type GraphId = GraphDef['id'];

export function graphById(id: string | null | undefined): GraphDef | undefined {
	return GRAPHS.find((g) => g.id === id);
}

/** SMN1 is the lightest example (35 segments), so it loads fast and stays
 * responsive on mobile — a sensible default when no locus is requested. */
export const DEFAULT_GENE = 'SMN1';

// Ceiling on the reduced GFA the browser will parse. The walks that used to
// dominate GFA size are aggregated away in the wasm query, so what's left is
// topology plus the sequence of every kept segment — and the sequence dominates,
// so the size grows with the window's width (roughly 1.3 MiB per Mb of reference).
// Gene-sized loci land two to three orders of magnitude under this; the ceiling
// is reached by wide windows, not by tangled ones. Measured on the v2.1 GRCh38
// graph (2026-09-25): a 5 Mb window (chr20:40–45 Mb) loads fine, while a 10 Mb
// window (chr20:40–50 Mb) came back at 13.4 MiB and is refused.
export const MAX_GFA_BYTES = 13 * 1024 * 1024;
