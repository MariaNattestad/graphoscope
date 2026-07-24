// Machine-readable complexity report for a queried locus — the payload the
// /api route emits for AI agents and scripts.
//
// Graphoscope has no backend (it's a static site on GitHub Pages; the query
// engine is wasm + HTTP range requests running in the browser), so this can't
// be a plain HTTP JSON endpoint. Instead the /api page runs the same client-
// side query and renders this object as JSON, which a JS-capable/headless
// browser reads. Keeping the shaping here — pure, no Svelte — makes it testable.

import { gfaStats, type Gfa } from './gfa';

/** Everything an agent needs to gauge "how tangled is this locus", derived from
 * the reduced graph the wasm query returns. Counts are post-simplification
 * unless the field name says "BeforeSimplification". */
export interface GraphComplexity {
	/** Distinct segments (nodes) after reference-guided simplification. */
	nodes: number;
	/** Segments in the raw subgraph, before simplification (from the reducer's
	 * X line). 0 if the response wasn't a reduced graph. */
	nodesBeforeSimplification: number;
	links: number;
	linksBeforeSimplification: number;
	/** Haplotype walks (paths) through the subgraph, reference included. */
	walks: number;
	/** Distinct haplotype samples contributing those walks. */
	samples: number;
	/** Sum of every distinct segment's sequence length in the subgraph. */
	totalSequenceBp: number;
	/** The reference's own genomic span across the window, or null if unknown. */
	referencePathBp: number | null;
	/** Superbubble sites the reducer identified. */
	variantSites: number;
	/** Single-base substitution sites among them. */
	snps: number;
	/** Nodes the simplification removed. */
	nodesRemoved: number;
	/** Sequence (bp) the simplification removed. */
	basesRemoved: number;
	/** Non-branching runs merged by unchop. */
	unchopMerges: number;
	/** True when the graph arrived reduced (the normal case); false means the
	 * counts are raw and the "before" fields are 0. */
	simplified: boolean;
}

export function graphComplexity(gfa: Gfa, referenceSample?: string): GraphComplexity {
	const s = gfaStats(gfa, referenceSample);
	const r = gfa.reduced;
	return {
		nodes: s.segments,
		nodesBeforeSimplification: r?.segmentsBefore ?? 0,
		links: s.links,
		linksBeforeSimplification: r?.linksBefore ?? 0,
		walks: s.walks,
		samples: s.samples,
		totalSequenceBp: s.totalSequenceBp,
		referencePathBp: s.referencePathBp,
		variantSites: r?.sites ?? 0,
		snps: r?.snpCount ?? 0,
		nodesRemoved: r?.nodesRemoved ?? 0,
		basesRemoved: r?.basesRemoved ?? 0,
		unchopMerges: r?.unchopMerges ?? 0,
		simplified: r !== undefined
	};
}

/** Context describing what was asked, echoed back so a saved report is self-
 * explanatory. */
export interface QueryContext {
	graph: string;
	referenceSample: string;
	/** The raw `locus` param the caller supplied (a gene symbol or coordinates). */
	input: string;
	/** Gene symbol, when the input resolved to one. */
	gene: string | null;
	contig: string;
	start: number;
	end: number;
	span: number;
}

/** Range-request telemetry for the query, useful for judging query cost. */
export interface FetchStats {
	requestCount: number;
	bytesFetched: number;
	dbSizeBytes: number;
	elapsedMs: number;
}

export interface ApiReport {
	ok: true;
	query: QueryContext;
	complexity: GraphComplexity;
	fetch: FetchStats | null;
}

export interface ApiError {
	ok: false;
	error: string;
	/** Present when the caller's params were the problem (bad locus, unknown
	 * graph), versus an internal/query failure. */
	query?: Partial<QueryContext>;
}
