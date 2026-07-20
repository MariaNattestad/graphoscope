export type Orient = '+' | '-';

export interface GfaSegment {
	id: string;
	length: number;
	sequence?: string;
	tags: Record<string, string>;
	/** Distinct non-reference walks through this node, from a reduced GFA's `WC`
	 * tag. Undefined for full GFA, where coverage is counted from the walks. */
	coverage?: number;
}

export interface GfaLink {
	from: string;
	fromOrient: Orient;
	to: string;
	toOrient: Orient;
	overlap: string;
}

// Field is named `id` (not `segId`) so it lines up with `../gfa`'s `Step` shape
// ({id, orient}) — that lets gfaToGraph.ts reuse a walk's existing step objects
// for a path's steps directly instead of allocating a new object per step
// (walks can have millions of steps on a large/repetitive locus).
export interface GfaPathStep {
	id: string;
	orient: Orient;
}

export interface GfaPath {
	name: string;
	steps: GfaPathStep[];
}

export interface GfaGraph {
	segments: Map<string, GfaSegment>;
	links: GfaLink[];
	paths: GfaPath[];
	version: string;
}

export interface GfaParseWarning {
	line: number;
	message: string;
}

export interface GfaParseResult {
	graph: GfaGraph;
	warnings: GfaParseWarning[];
}
