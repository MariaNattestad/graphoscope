// The two hosted graphs, shared between the interactive page and the machine-
// readable /api route so a coordinate means the same thing in both.
//
// Both are HPRC Release 2 (v2.0) Minigraph-Cactus pangenome graphs. We took the
// public `.gbz` files, converted each to a GBZ-base `.gbz.db` (SQLite) with
// `gbz2db`, and host them on Cloudflare R2 with CORS + HTTP range support so the
// browser can query a locus without downloading the multi-GB database.

import type { RefKey } from './genes';

export const R2_BASE = 'https://pub-32138fb437f04b75ac10fea079052edb.r2.dev';

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
		dbUrl: `${R2_BASE}/hprc-v2.0-mc-grch38.gbz.db`,
		s3Source:
			's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/hprc-v2.0-mc-grch38.gbz'
	},
	{
		id: 'chm13',
		label: 'CHM13-based (T2T)',
		referenceSample: 'CHM13',
		refKey: 'chm13',
		dbUrl: `${R2_BASE}/hprc-v2.0-mc-chm13.gbz.db`,
		s3Source:
			's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/hprc-v2.0-mc-chm13.gbz'
	}
];

export type GraphId = GraphDef['id'];

export function graphById(id: string | null | undefined): GraphDef | undefined {
	return GRAPHS.find((g) => g.id === id);
}

/** SMN1 is the lightest example (35 segments), so it loads fast and stays
 * responsive on mobile — a sensible default when no locus is requested. */
export const DEFAULT_GENE = 'SMN1';

// Backstop only. The walks that used to dominate GFA size are aggregated away in
// the wasm query, so a reduced response is governed by topology: measured loci
// from 10 kb to 3.2 Mb all came back three orders of magnitude under this
// ceiling. Reaching it means something pathological, and we refuse rather than
// try to render.
export const MAX_GFA_BYTES = 13 * 1024 * 1024;
