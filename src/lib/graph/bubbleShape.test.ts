import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { gfaToGraph } from './gfaToGraph';
import { buildAndRunLayout } from './forceLayout';
import { ALL_FIXTURES } from './fixtures';
import { loopPoint } from './bubbleShape';

// The 'nested' fixture is two 120 bp insertion alleles at one reference point
// that share their first 60 bp. Each allele is a long strand tied to the
// reference at both ends, which used to crumple into a tangle of loops; on the
// Strands layout it should come out as one smooth loop.

type Pt = { x: number; y: number };

function strandsLayout() {
	const fixture = ALL_FIXTURES.find((f) => f.id === 'nested')!;
	const graph = gfaToGraph(parseGfa(fixture.gfaText), { referenceSample: fixture.referenceSample }).graph;
	return buildAndRunLayout(graph, { referenceSample: fixture.referenceSample, mode: 'stacked' });
}

function allelePolyline(layout: ReturnType<typeof strandsLayout>, segs: string[]): Pt[] {
	const chains = new Map(layout.chains.map((c) => [c.segId, c]));
	return segs.flatMap((s) => chains.get(s)!.nodeIds.map((id) => layout.nodesById.get(id)!));
}

function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
	const side = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
	return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

describe('bubble strings', () => {
	it('lay a long insertion out as one smooth loop', () => {
		const layout = strandsLayout();
		for (const allele of [
			['20', '21'],
			['20', '22']
		]) {
			const pts = allelePolyline(layout, allele);
			for (let i = 0; i + 1 < pts.length; i++) {
				for (let j = i + 2; j + 1 < pts.length; j++) {
					expect(crosses(pts[i], pts[i + 1], pts[j], pts[j + 1]), `${allele} crosses itself`).toBe(false);
				}
			}
			// A loop stands about 1/π of its length tall; a crumpled strand far less.
			let length = 0;
			for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
			const height = -Math.min(...pts.map((p) => p.y));
			expect(height / length, `${allele} stands up`).toBeGreaterThan(0.25);
		}
	});

	it('is deterministic', () => {
		const a = strandsLayout();
		const b = strandsLayout();
		for (const [id, n] of a.nodesById) {
			expect(b.nodesById.get(id)!.x).toBe(n.x);
			expect(b.nodesById.get(id)!.y).toBe(n.y);
		}
	});

	it('keep a loop inside its room, at the same length', () => {
		// A 3000 px insertion at x=0 would be a circle ~950 px wide; its neighbours
		// attach 200 px away on each side, so it has to become a hairpin.
		for (const [lo, hi] of [
			[-Infinity, Infinity],
			[-100, 100]
		]) {
			const pts = Array.from({ length: 301 }, (_, i) => loopPoint(0, 0, i * 10, 3000, lo, hi));
			let length = 0;
			for (let i = 1; i < pts.length; i++) {
				length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].height - pts[i - 1].height);
			}
			expect(length).toBeCloseTo(3000, -1);
			for (const p of pts) {
				expect(p.x).toBeGreaterThanOrEqual(Math.max(lo, -500) - 1e-6);
				expect(p.x).toBeLessThanOrEqual(Math.min(hi, 500) + 1e-6);
			}
		}
	});
});
