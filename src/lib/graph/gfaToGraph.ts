// Adapter: map the pangenome-viz `Gfa` (from gbz-base query output) onto the
// layout module's `GfaGraph` model, so the deterministic backbone layout can be
// reused unchanged. Graph simplification (small-variant popping, unchop) now
// happens upstream in simplify.ts, so this is a plain structural mapping.
import type { Gfa } from '../gfa';
import type { GfaGraph, GfaLink, GfaPath, Orient } from './types';

export interface AdaptOptions {
	/** Which sample is the reference; used for backbone choice + coloring. */
	referenceSample?: string;
}

export interface AdaptResult {
	graph: GfaGraph;
	keptSegments: number;
	/** Reference segment ids (on the reference walk), for coloring/backbone. */
	referenceSegIds: Set<string>;
}

export function gfaToGraph(gfa: Gfa, opts: AdaptOptions = {}): AdaptResult {
	const { referenceSample } = opts;

	// Reference segments = those on any walk of the reference sample. Fall back to
	// the first walk if the named sample isn't present (matches the other views).
	const refWalks = referenceSample ? gfa.walks.filter((w) => w.sample === referenceSample) : [];
	const refFallback = refWalks.length === 0 && gfa.walks.length > 0 ? [gfa.walks[0]] : [];
	const referenceSegIds = new Set<string>();
	for (const w of [...refWalks, ...refFallback]) {
		for (const s of w.steps) referenceSegIds.add(s.id);
	}

	const segments: GfaGraph['segments'] = new Map();
	for (const s of gfa.segments.values()) {
		segments.set(s.id, { id: s.id, length: s.length, sequence: s.seq, tags: {} });
	}

	const links: GfaLink[] = [];
	for (const l of gfa.links) {
		if (!segments.has(l.from) || !segments.has(l.to)) continue;
		links.push({
			from: l.from,
			fromOrient: l.fromOrient as Orient,
			to: l.to,
			toOrient: l.toOrient as Orient,
			overlap: '*'
		});
	}

	// `w.steps` are reused directly (filter only, no `.map()`) rather than
	// rebuilt into new `{id, orient}` objects — `Step` and `GfaPathStep` share
	// that exact shape (see types.ts) specifically so this can share the same
	// step objects instead of allocating a second copy of every step of every
	// walk, which is the dominant cost on a large/repetitive locus (a walk can
	// have thousands of steps, and there can be thousands of walks).
	const paths: GfaPath[] = gfa.walks.map((w) => ({
		name: `${w.sample}#${w.hapIndex}#${w.seqId}`,
		steps: w.steps.filter((s) => segments.has(s.id))
	}));

	return {
		graph: { segments, links, paths, version: '1.1' },
		keptSegments: segments.size,
		referenceSegIds
	};
}
