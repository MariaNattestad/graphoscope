// Off-locus exit cues: which drawn strand ends are loose. A haplotype that
// continues past the queried locus is chopped at the subgraph boundary, leaving a
// non-backbone chain end that no structural link attaches to. The canvas draws a
// fading dashed line from each such end (GraphCanvas drawExitCues), and reports
// the segments that have one so the inspector can say a bubble/walk leaves the
// locus.

import type { LayoutResult } from './forceLayout';

export interface ExitEnd {
	segId: string;
	/** The loose chain-end node the cue starts from. */
	nodeId: string;
}

/** Every loose end of a non-backbone chain, one per chain end. */
export function findExitEnds(layout: Pick<LayoutResult, 'chains' | 'structuralLinkPaths' | 'backboneSegIds'>): ExitEnd[] {
	const linked = new Set<string>();
	for (const l of layout.structuralLinkPaths) {
		linked.add(l.fromNode);
		linked.add(l.toNode);
	}
	const out: ExitEnd[] = [];
	for (const chain of layout.chains) {
		if (layout.backboneSegIds.has(chain.segId)) continue; // the reference axis marks its own ends
		const ids = chain.nodeIds;
		if (ids.length > 0 && !linked.has(ids[0])) out.push({ segId: chain.segId, nodeId: ids[0] });
		if (ids.length > 1 && !linked.has(ids[ids.length - 1]))
			out.push({ segId: chain.segId, nodeId: ids[ids.length - 1] });
	}
	return out;
}
