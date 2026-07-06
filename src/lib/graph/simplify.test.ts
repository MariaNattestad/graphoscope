import { describe, it, expect } from 'vitest';
import { parseGfa, type Gfa } from '../gfa';
import { ALL_FIXTURES, SYNTHETIC_FIXTURES, type Fixture } from './fixtures';
import { popSmallVariants, simplify } from './simplify';

const MAX_VARIANT = 50;

// --- invariant helpers -------------------------------------------------------

function undirectedEdges(gfa: Gfa): Set<string> {
	const s = new Set<string>();
	for (const l of gfa.links) {
		if (l.from === l.to) continue;
		s.add(l.from < l.to ? `${l.from} ${l.to}` : `${l.to} ${l.from}`);
	}
	return s;
}

/** Concatenated sequence (and length) of the reference walk. */
function refSequence(gfa: Gfa, sample: string): { seq: string; len: number } {
	const ref = gfa.walks.find((w) => w.sample === sample) ?? gfa.walks[0];
	if (!ref) return { seq: '', len: 0 };
	let seq = '';
	let len = 0;
	for (const step of ref.steps) {
		const s = gfa.segments.get(step.id);
		if (!s) throw new Error(`reference step ${step.id} missing from segments`);
		seq += s.seq;
		len += s.length;
	}
	return { seq, len };
}

/** Every walk step exists and consecutive steps are backed by a real edge. */
function assertWalksValid(gfa: Gfa) {
	const edges = undirectedEdges(gfa);
	for (const w of gfa.walks) {
		for (let i = 0; i < w.steps.length; i++) {
			expect(gfa.segments.has(w.steps[i].id), `walk step ${w.steps[i].id} exists`).toBe(true);
			if (i > 0) {
				const a = w.steps[i - 1].id;
				const b = w.steps[i].id;
				if (a === b) continue;
				const key = a < b ? `${a} ${b}` : `${b} ${a}`;
				expect(edges.has(key), `edge for consecutive steps ${a}->${b} exists`).toBe(true);
			}
		}
	}
}

/** All link endpoints resolve to real segments. */
function assertLinksResolve(gfa: Gfa) {
	for (const l of gfa.links) {
		expect(gfa.segments.has(l.from), `link.from ${l.from}`).toBe(true);
		expect(gfa.segments.has(l.to), `link.to ${l.to}`).toBe(true);
	}
}

// --- per-fixture expectations ------------------------------------------------

describe('popSmallVariants — synthetic expectations', () => {
	for (const fx of SYNTHETIC_FIXTURES) {
		it(fx.id, () => {
			const gfa = parseGfa(fx.gfaText);
			const { gfa: out, sites, stats } = popSmallVariants(gfa, {
				referenceSample: fx.referenceSample,
				maxVariant: MAX_VARIANT
			});
			const e = fx.expect!;
			expect(stats.sites, 'sites').toBe(e.sites);
			expect(stats.nodesRemoved, 'nodesRemoved').toBe(e.nodesRemoved);
			expect(stats.snpCount, 'snpCount').toBe(e.snpCount);
			expect(stats.basesRemoved, 'basesRemoved').toBe(e.basesRemoved);
			for (const id of e.removedNodes ?? []) expect(out.segments.has(id), `removed ${id}`).toBe(false);
			for (const id of e.keptNodes ?? []) expect(out.segments.has(id), `kept ${id}`).toBe(true);
			// every collapsed site's longest path was below the threshold
			for (const s of sites) expect(s.maxPathBases).toBeLessThan(MAX_VARIANT);
		});
	}
});

describe('simplify — segment count after pop + unchop', () => {
	for (const fx of SYNTHETIC_FIXTURES) {
		if (fx.expect?.segmentsAfterSimplify === undefined) continue;
		it(fx.id, () => {
			const gfa = parseGfa(fx.gfaText);
			const { stats } = simplify(gfa, { referenceSample: fx.referenceSample, maxVariant: MAX_VARIANT });
			expect(stats.segmentsAfter).toBe(fx.expect!.segmentsAfterSimplify);
		});
	}
});

// --- invariants across ALL fixtures (synthetic + real) -----------------------

describe('invariants hold for every fixture', () => {
	for (const fx of ALL_FIXTURES) {
		it(`${fx.id} (${fx.kind})`, () => {
			const input = parseGfa(fx.gfaText);
			const inputEdges = undirectedEdges(input);
			const inputRef = refSequence(input, fx.referenceSample);

			// pop pass
			const popped = popSmallVariants(input, {
				referenceSample: fx.referenceSample,
				maxVariant: MAX_VARIANT
			});
			// anti-artifact: output edges ⊆ input edges
			for (const e of undirectedEdges(popped.gfa))
				expect(inputEdges.has(e), `pop introduced edge ${e}`).toBe(true);
			assertLinksResolve(popped.gfa);
			assertWalksValid(popped.gfa);
			for (const s of popped.sites) expect(s.maxPathBases).toBeLessThan(MAX_VARIANT);
			// reference sequence unchanged
			const poppedRef = refSequence(popped.gfa, fx.referenceSample);
			expect(poppedRef.len, 'ref length after pop').toBe(inputRef.len);
			expect(poppedRef.seq, 'ref sequence after pop').toBe(inputRef.seq);

			// full pipeline (pop + unchop)
			const full = simplify(input, { referenceSample: fx.referenceSample, maxVariant: MAX_VARIANT });
			assertLinksResolve(full.gfa);
			assertWalksValid(full.gfa);
			const fullRef = refSequence(full.gfa, fx.referenceSample);
			expect(fullRef.len, 'ref length after simplify').toBe(inputRef.len);
			expect(fullRef.seq, 'ref sequence after simplify').toBe(inputRef.seq);
			expect(full.gfa.segments.size, 'no growth').toBeLessThanOrEqual(input.segments.size);
		});
	}
});

describe('real loci actually get simplified', () => {
	for (const fx of ALL_FIXTURES.filter((f) => f.kind === 'real')) {
		it(fx.id, () => {
			const input = parseGfa(fx.gfaText);
			const full = simplify(input, { referenceSample: fx.referenceSample, maxVariant: MAX_VARIANT });
			expect(full.gfa.segments.size, 'fewer segments').toBeLessThan(input.segments.size);
		});
	}
});
