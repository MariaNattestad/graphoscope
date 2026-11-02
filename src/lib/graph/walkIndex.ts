// Walk-mode indexing: which full-graph walks pass through each displayed segment,
// and which take each deletion (skip) edge. Pure functions so the counting can be
// tested against a fixture rather than only in the canvas.

import type { Gfa, Orient, Walk } from '../gfa';

export interface DiscoStep {
	id: string;
	orient: Orient;
}

/** Map every original node id to the displayed segment that represents it — the
 * segment itself, or the unchop-merged u-chain that swallowed it (`members`).
 * Popped small variants aren't in the map. On the full graph this is 1:1. */
export function buildOrigToDisplayed(gfa: Gfa): Map<string, string> {
	const m = new Map<string, string>();
	for (const seg of gfa.segments.values()) {
		m.set(seg.id, seg.id);
		if (seg.members) for (const orig of seg.members) m.set(orig, seg.id);
	}
	return m;
}

/** Project a walk onto the displayed segments: map each step through
 * origToDisplayed, drop steps with no representative here (popped), and collapse
 * a run of steps that all landed in the same displayed segment into one. */
export function projectWalk(
	steps: readonly DiscoStep[],
	origToDisplayed: Map<string, string>
): DiscoStep[] | null {
	const out: DiscoStep[] = [];
	let lastId: string | null = null;
	for (const step of steps) {
		const id = origToDisplayed.get(step.id);
		if (!id || id === lastId) continue;
		out.push({ id, orient: step.orient });
		lastId = id;
	}
	return out.length > 0 ? out : null;
}

export interface WalkIndex {
	/** Displayed segment -> the (unprojected) steps of every walk touching it. */
	byNode: Map<string, DiscoStep[][]>;
	/** Skip key -> the projected path of every walk that takes that skip edge. One
	 * entry per walk, so `length` is the walk count; several walks often share a
	 * projected path (they differ only in popped variants). */
	bySkip: Map<string, DiscoStep[][]>;
}

/** Index every walk under the displayed segments it touches, and under each skip
 * (deletion) edge it *takes* — a walk takes a skip when its projected path steps
 * straight from the skip's `from` segment to its `to` segment, in either direction
 * (walks don't name edges, but a traversed edge is just two consecutive steps). */
export function buildWalkIndex(
	walks: readonly Walk[],
	origToDisplayed: Map<string, string>,
	skips: readonly { key: string; from: string; to: string }[]
): WalkIndex {
	const skipByPair = new Map<string, string>();
	for (const s of skips) {
		skipByPair.set(`${s.from}>${s.to}`, s.key);
		skipByPair.set(`${s.to}>${s.from}`, s.key);
	}
	const byNode = new Map<string, DiscoStep[][]>();
	const bySkip = new Map<string, DiscoStep[][]>();
	for (const w of walks) {
		if (w.kind === 'synthetic') continue; // the computed backbone isn't a real walk
		if (w.steps.length < 2) continue;
		// File the walk under every displayed segment it touches (deduped).
		const touched = new Set<string>();
		for (const s of w.steps) {
			const d = origToDisplayed.get(s.id);
			if (d) touched.add(d);
		}
		for (const d of touched) {
			let arr = byNode.get(d);
			if (!arr) byNode.set(d, (arr = []));
			arr.push(w.steps);
		}
		// …and under every skip edge its projected path traverses.
		if (skipByPair.size === 0) continue;
		const p = projectWalk(w.steps, origToDisplayed);
		if (!p || p.length < 2) continue;
		let matched: Set<string> | null = null;
		for (let i = 0; i + 1 < p.length; i++) {
			const key = skipByPair.get(`${p[i].id}>${p[i + 1].id}`);
			if (key) (matched ??= new Set()).add(key);
		}
		if (matched)
			for (const k of matched) {
				let arr = bySkip.get(k);
				if (!arr) bySkip.set(k, (arr = []));
				arr.push(p);
			}
	}
	return { byNode, bySkip };
}

/** How many walks a list of traces stands for — one per walk, *not* per distinct
 * projected path: walks that differ only in popped small variants project to the
 * same path but are still separate walks (and the bubble inspector's count, from
 * the reduced graph's WC coverage, counts them separately too). */
export function countWalks(paths: readonly (DiscoStep[] | null)[]): number {
	let n = 0;
	for (const p of paths) if (p && p.length > 0) n++;
	return n;
}

/** How many distinct projected paths a list of traces draws as. */
export function countDistinctTraces(paths: readonly (DiscoStep[] | null)[]): number {
	const seen = new Set<string>();
	for (const p of paths) if (p && p.length > 0) seen.add(p.map((s) => s.id).join('>'));
	return seen.size;
}
