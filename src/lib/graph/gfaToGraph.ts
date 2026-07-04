// Adapter: map the pangenome-viz `Gfa` (from gbz-base query output) onto the
// layout module's `GfaGraph` model, so the deterministic backbone layout can be
// reused unchanged.
//
// This is also where the first cut of graph *simplification* lives: for large
// subgraphs we can collapse small non-reference bubbles (drop short alt nodes,
// keeping the reference path intact) and/or drop stored sequences to save
// memory. These are cheap, streaming-friendly passes over the already-parsed
// graph; the heavier Rust/WASM version can slot in behind the same interface
// later if profiling shows TS is the bottleneck.
import type { Gfa } from '../gfa';
import type { GfaGraph, GfaLink, GfaPath, Orient } from './types';

export interface AdaptOptions {
	/** Which sample is the reference; its walk is protected from pruning. */
	referenceSample?: string;
	/**
	 * Collapse small bubbles: drop non-reference segments whose length is <= this
	 * (and the links touching them). Reference segments are always kept. 0 keeps
	 * everything.
	 */
	pruneBelow?: number;
	/** Drop stored base sequences (keep only lengths) to cut memory on big graphs. */
	dropSequences?: boolean;
}

export interface AdaptResult {
	graph: GfaGraph;
	keptSegments: number;
	droppedSegments: number;
	droppedLinks: number;
	/** Reference segment ids (on the reference walk), for coloring/backbone. */
	referenceSegIds: Set<string>;
}

export function gfaToGraph(gfa: Gfa, opts: AdaptOptions = {}): AdaptResult {
	const { referenceSample, pruneBelow = 0, dropSequences = false } = opts;

	// Reference segments = those on any walk of the reference sample. Fall back to
	// the first walk if the named sample isn't present (matches the other views).
	const refWalks = referenceSample
		? gfa.walks.filter((w) => w.sample === referenceSample)
		: [];
	const refFallback = refWalks.length === 0 && gfa.walks.length > 0 ? [gfa.walks[0]] : [];
	const referenceSegIds = new Set<string>();
	for (const w of [...refWalks, ...refFallback]) {
		for (const s of w.steps) referenceSegIds.add(s.id);
	}

	// Decide which segments survive pruning.
	const keep = (id: string, length: number): boolean =>
		pruneBelow <= 0 || referenceSegIds.has(id) || length > pruneBelow;

	const segments: GfaGraph['segments'] = new Map();
	let droppedSegments = 0;
	for (const s of gfa.segments.values()) {
		if (!keep(s.id, s.length)) {
			droppedSegments++;
			continue;
		}
		segments.set(s.id, {
			id: s.id,
			length: s.length,
			sequence: dropSequences ? undefined : s.seq,
			tags: {}
		});
	}

	const links: GfaLink[] = [];
	let droppedLinks = 0;
	for (const l of gfa.links) {
		if (!segments.has(l.from) || !segments.has(l.to)) {
			droppedLinks++;
			continue;
		}
		links.push({
			from: l.from,
			fromOrient: l.fromOrient as Orient,
			to: l.to,
			toOrient: l.toOrient as Orient,
			overlap: '*'
		});
	}

	// Walks -> paths. Drop steps that landed on pruned segments so the path only
	// references surviving nodes (used for backbone choice + coverage counts).
	const paths: GfaPath[] = gfa.walks.map((w) => ({
		name: `${w.sample}#${w.hapIndex}#${w.seqId}`,
		steps: w.steps
			.filter((s) => segments.has(s.id))
			.map((s) => ({ segId: s.id, orient: s.orient as Orient }))
	}));

	return {
		graph: { segments, links, paths, version: '1.1' },
		keptSegments: segments.size,
		droppedSegments,
		droppedLinks,
		referenceSegIds
	};
}
