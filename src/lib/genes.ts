// Gene-name → reference-coordinate lookup for the Locus field.
//
// A public, zero-backend app can't hit a gene database at query time (CORS,
// rate limits, downtime), so instead we ship a compact symbol→coordinate map
// per reference as a static asset and load it lazily the first time the user
// types a gene name. The maps are generated offline from GENCODE (GRCh38) and
// the T2T-CHM13v2.0 gene annotation (CHM13); see `scripts/build-genes.mjs`.
//
// Kept deliberately small and dependency-free so it can be lifted out into a
// standalone npm package ("gene coordinates as a static JSON, per assembly")
// later with almost no change.

import { base } from '$app/paths';

/** Which reference assembly a gene map is keyed to. Matches the graph's reference. */
export type RefKey = 'grch38' | 'chm13';

export interface GeneEntry {
	/** Display symbol, original casing (e.g. "TP53"). */
	name: string;
	contig: string;
	/** 0-based start. */
	start: number;
	/** half-open end. */
	end: number;
}

/** Raw on-disk format: { SYMBOL: [contig, start, end] }. Compact on purpose. */
type GeneFile = Record<string, [string, number, number]>;

// Lazy per-reference load; resolves to an empty map if the asset is missing so
// the app degrades to coordinate-only input rather than throwing.
const cache = new Map<RefKey, Promise<Map<string, GeneEntry>>>();

export function loadGenes(ref: RefKey): Promise<Map<string, GeneEntry>> {
	let p = cache.get(ref);
	if (!p) {
		p = fetch(`${base}/genes/genes-${ref}.json`)
			.then((r) => (r.ok ? (r.json() as Promise<GeneFile>) : ({} as GeneFile)))
			.then((obj) => {
				const m = new Map<string, GeneEntry>();
				for (const [name, v] of Object.entries(obj)) {
					if (!Array.isArray(v) || v.length < 3) continue;
					m.set(name.toUpperCase(), { name, contig: v[0], start: v[1], end: v[2] });
				}
				return m;
			})
			.catch(() => new Map<string, GeneEntry>());
		cache.set(ref, p);
	}
	return p;
}

/**
 * Genes overlapping a coordinate window, for drawing a gene track against a
 * locus. Scans the whole map (~20k entries, once per locus) rather than
 * carrying an interval index — at this size the scan is not worth optimizing.
 * Sorted by start so a caller can pack them into rows left to right.
 */
export async function genesInRange(
	ref: RefKey,
	contig: string,
	start: number,
	end: number
): Promise<GeneEntry[]> {
	const genes = await loadGenes(ref);
	const out: GeneEntry[] = [];
	for (const g of genes.values()) {
		if (g.contig === contig && g.start < end && g.end > start) out.push(g);
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

/** Exact (case-insensitive) symbol lookup. Returns null if not a known gene. */
export async function resolveGene(ref: RefKey, symbol: string): Promise<GeneEntry | null> {
	const genes = await loadGenes(ref);
	return genes.get(symbol.trim().toUpperCase()) ?? null;
}

/**
 * Prefix search for the autocomplete. Ranks exact matches first, then symbols
 * that start with the query, then substring matches — each group alphabetical.
 */
export async function searchGenes(ref: RefKey, query: string, limit = 8): Promise<GeneEntry[]> {
	const q = query.trim().toUpperCase();
	if (q.length < 1) return [];
	const genes = await loadGenes(ref);
	const exact: GeneEntry[] = [];
	const prefix: GeneEntry[] = [];
	const infix: GeneEntry[] = [];
	for (const [key, entry] of genes) {
		if (key === q) exact.push(entry);
		else if (key.startsWith(q)) prefix.push(entry);
		else if (key.includes(q)) infix.push(entry);
		if (prefix.length > limit * 4 && infix.length > limit * 4) break; // enough to sort from
	}
	const byName = (a: GeneEntry, b: GeneEntry) => a.name.localeCompare(b.name);
	prefix.sort(byName);
	infix.sort(byName);
	return [...exact, ...prefix, ...infix].slice(0, limit);
}

/**
 * Turn a gene into a locus window. Genes shorter than `minWindow` are padded
 * symmetrically so the graph has some context to show; larger genes are used
 * as-is. Returns a `contig:start-end` string ready for the Locus field.
 */
export function geneToLocus(gene: GeneEntry, minWindow = 20000): string {
	const span = gene.end - gene.start;
	let start = gene.start;
	let end = gene.end;
	if (span < minWindow) {
		const pad = Math.round((minWindow - span) / 2);
		start = Math.max(0, gene.start - pad);
		end = gene.end + pad;
	}
	return `${gene.contig}:${start}-${end}`;
}
