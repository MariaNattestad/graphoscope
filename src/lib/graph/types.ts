export type Orient = '+' | '-';

export interface GfaSegment {
	id: string;
	length: number;
	sequence?: string;
	tags: Record<string, string>;
}

export interface GfaLink {
	from: string;
	fromOrient: Orient;
	to: string;
	toOrient: Orient;
	overlap: string;
}

export interface GfaPathStep {
	segId: string;
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
