import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { gfaToGraph } from './gfaToGraph';
import { buildAndRunLayout, type LayoutResult } from './forceLayout';
import type { LayoutMode } from './layoutModes';

// The STAT2 3' polymorphic TE insertion (chr12:56,340,719-56,361,116, GRCh38,
// simplified): a 322 bp insertion (…770) reached through a run of 1 bp nodes
// (…766-769) with skip links between them, all hanging off one reference cut
// site. The force layout stacked it into a single unreadable column.
const STAT2 = [
	'H\tVN:Z:1.1\tRS:Z:GRCh38',
	'S\tu41276132\t*\tLN:i:18746',
	'S\t41276766\t*\tLN:i:1',
	'S\t41276767\t*\tLN:i:1',
	'S\t41276768\t*\tLN:i:1',
	'S\t41276769\t*\tLN:i:1',
	'S\t41276770\t*\tLN:i:322',
	'S\tu41276771\t*\tLN:i:1121',
	'S\t41276801\t*\tLN:i:1',
	'S\t41276802\t*\tLN:i:1',
	'S\t41276803\t*\tLN:i:1',
	'S\tu41276804\t*\tLN:i:527',
	'W\tGRCh38\t0\tchr12\t56340719\t56361116\t>u41276132>u41276771>41276801>41276802>41276803>u41276804',
	'L\tu41276132\t+\t41276766\t+\t0M',
	'L\tu41276132\t+\tu41276771\t+\t0M',
	'L\t41276766\t+\t41276767\t+\t0M',
	'L\t41276766\t+\t41276768\t+\t0M',
	'L\t41276766\t+\t41276769\t+\t0M',
	'L\t41276766\t+\t41276770\t+\t0M',
	'L\t41276767\t+\t41276768\t+\t0M',
	'L\t41276768\t+\t41276769\t+\t0M',
	'L\t41276769\t+\t41276770\t+\t0M',
	'L\t41276770\t+\tu41276771\t+\t0M',
	'L\tu41276771\t+\t41276801\t+\t0M',
	'L\tu41276771\t+\t41276803\t+\t0M',
	'L\t41276801\t+\t41276802\t+\t0M',
	'L\t41276801\t+\tu41276804\t+\t0M',
	'L\t41276802\t+\t41276803\t+\t0M',
	'L\t41276803\t+\tu41276804\t+\t0M'
].join('\n');

const ALT = ['41276766', '41276767', '41276768', '41276769', '41276770'];

type P = { x: number; y: number };

function layoutOf(text: string, mode: LayoutMode = 'classic'): LayoutResult {
	const graph = gfaToGraph(parseGfa(text), { referenceSample: 'GRCh38' }).graph;
	return buildAndRunLayout(graph, { referenceSample: 'GRCh38', mode });
}

/** Every drawn line as a polyline: each segment's strand, and each link through
 * its bend node (a quadratic, sampled). Reference-to-reference skips are drawn
 * by the canvas as deletion arcs, not from layout positions, so they're left out. */
function drawnLines(layout: LayoutResult) {
	const n = (id: string) => layout.nodesById.get(id)!;
	const lines: { ends: string[]; pts: P[] }[] = layout.chains.map((c) => ({
		ends: [c.segId],
		pts: c.nodeIds.map(n)
	}));
	for (const p of layout.structuralLinkPaths) {
		if (layout.backboneSegIds.has(p.from) && layout.backboneSegIds.has(p.to)) continue;
		const a = n(p.fromNode);
		const b = n(p.toNode);
		const m = p.bendNode ? n(p.bendNode) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		const pts: P[] = [];
		for (let i = 0; i <= 12; i++) {
			const t = i / 12;
			const u = 1 - t;
			pts.push({ x: u * u * a.x + 2 * u * t * m.x + t * t * b.x, y: u * u * a.y + 2 * u * t * m.y + t * t * b.y });
		}
		lines.push({ ends: [p.from, p.to], pts });
	}
	return lines;
}

function properlyCross(p1: P, p2: P, p3: P, p4: P): boolean {
	const d = (a: P, b: P, c: P) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	const d1 = d(p3, p4, p1);
	const d2 = d(p3, p4, p2);
	const d3 = d(p1, p2, p3);
	const d4 = d(p1, p2, p4);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Pairs of drawn lines that cross, ignoring pairs that share a segment (those
 * meet at that segment's end by construction). */
function crossings(layout: LayoutResult): number {
	const lines = drawnLines(layout);
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			const A = lines[i];
			const B = lines[j];
			if (A.ends.some((e) => B.ends.includes(e))) continue;
			let hit = false;
			for (let s = 0; s + 1 < A.pts.length && !hit; s++) {
				for (let t = 0; t + 1 < B.pts.length && !hit; t++) {
					hit = properlyCross(A.pts[s], A.pts[s + 1], B.pts[t], B.pts[t + 1]);
				}
			}
			if (hit) count++;
		}
	}
	return count;
}

describe('bubble lanes layout', () => {
	const layout = layoutOf(STAT2);
	const chain = (seg: string) => layout.chains.find((c) => c.segId === seg)!.nodeIds.map((id) => layout.nodesById.get(id)!);

	it('keeps the reference on the axis and every alt node above it', () => {
		for (const seg of layout.backboneSegIds) for (const n of chain(seg)) expect(n.y).toBe(0);
		for (const seg of ALT) for (const n of chain(seg)) expect(n.y).toBeLessThan(0);
	});

	it('lays the insertion out left to right instead of stacking it on one x', () => {
		// Each alt node starts where the previous one ends, along one lane.
		const spans = ALT.map((seg) => {
			const xs = chain(seg).map((n) => n.x);
			return { lo: Math.min(...xs), hi: Math.max(...xs), y: chain(seg)[0].y };
		});
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].lo).toBeCloseTo(spans[i - 1].hi, 6);
			expect(spans[i].y).toBe(spans[0].y);
		}
		// Each node gets real width, and the 322 bp node is the widest.
		for (const s of spans) expect(s.hi - s.lo).toBeGreaterThan(0);
		const te = spans[4].hi - spans[4].lo;
		for (const s of spans.slice(0, 4)) expect(te).toBeGreaterThan(s.hi - s.lo);
	});

	it('draws no crossing edges', () => {
		expect(crossings(layout)).toBe(0);
	});

	it('nests the skip links instead of drawing them over the lane', () => {
		// The three skips out of …766 bow above the lane, higher the further they jump.
		const bows = ['41276768', '41276769', '41276770'].map((to) => {
			const p = layout.structuralLinkPaths.find((l) => l.from === '41276766' && l.to === to)!;
			return layout.nodesById.get(p.bendNode)!.y;
		});
		const laneY = chain('41276766')[0].y;
		expect(bows[0]).toBeLessThan(laneY);
		expect(bows[1]).toBeLessThan(bows[0]);
		expect(bows[2]).toBeLessThan(bows[1]);
	});
});

// A 200 bp alternative allele that the graph splits into 200 1 bp nodes, beside
// the 200 bp reference segment it replaces. Each tiny node used to get a
// minimum width, and those added up until the allele was drawn several times
// wider than its sequence.
const RUN = 200;
const RUN_GFA = [
	'H\tVN:Z:1.1\tRS:Z:GRCh38',
	'S\tleft\t*\tLN:i:1000',
	'S\tref\t*\tLN:i:200',
	'S\tright\t*\tLN:i:1000',
	...Array.from({ length: RUN }, (_, i) => `S\ta${i}\t*\tLN:i:1`),
	'W\tGRCh38\t0\tchr1\t0\t2200\t>left>ref>right',
	'L\tleft\t+\tref\t+\t0M',
	'L\tref\t+\tright\t+\t0M',
	'L\tleft\t+\ta0\t+\t0M',
	...Array.from({ length: RUN - 1 }, (_, i) => `L\ta${i}\t+\ta${i + 1}\t+\t0M`),
	`L\ta${RUN - 1}\t+\tright\t+\t0M`
].join('\n');

describe('bubble lanes layout, bp scale', () => {
	it('draws an allele exactly as wide as the same bp of reference', () => {
		const layout = layoutOf(RUN_GFA);
		const xsOf = (seg: string) => layout.chains.find((c) => c.segId === seg)!.nodeIds.map((id) => layout.nodesById.get(id)!.x);
		const alt = Array.from({ length: RUN }, (_, i) => xsOf(`a${i}`)).flat();
		const altWidth = Math.max(...alt) - Math.min(...alt);
		const refXs = xsOf('ref');
		expect(altWidth).toBeCloseTo(Math.max(...refXs) - Math.min(...refXs), 6);
		// The reference itself is linear in bp: no gaps between its nodes.
		expect(Math.min(...refXs)).toBeCloseTo(Math.max(...xsOf('left')), 6);
		expect(Math.min(...xsOf('right'))).toBeCloseTo(Math.max(...refXs), 6);
		// …and the nodes still run left to right rather than piling up.
		for (let i = 1; i < RUN; i++) expect(Math.min(...xsOf(`a${i}`))).toBeCloseTo(Math.max(...xsOf(`a${i - 1}`)), 6);
	});
});

// Ten SNPs on consecutive reference bases in the middle of a 20 kb window: at
// bp scale their anchors are a hair apart, so they used to stack ten rows high
// over one point. With empty reference on either side they spread out instead.
const SNPS = 10;
const SNP_GFA = [
	'H\tVN:Z:1.1\tRS:Z:GRCh38',
	'S\tleft\t*\tLN:i:10000',
	'S\tright\t*\tLN:i:10000',
	...Array.from({ length: SNPS }, (_, i) => `S\tr${i}\t*\tLN:i:1\nS\ts${i}\t*\tLN:i:1`),
	`W\tGRCh38\t0\tchr1\t0\t${20000 + SNPS}\t>left${Array.from({ length: SNPS }, (_, i) => `>r${i}`).join('')}>right`,
	...Array.from({ length: SNPS }, (_, i) => {
		const prev = i === 0 ? 'left' : `r${i - 1}`;
		const next = i === SNPS - 1 ? 'right' : `r${i + 1}`;
		return [`L\t${prev}\t+\tr${i}\t+\t0M`, `L\t${prev}\t+\ts${i}\t+\t0M`, `L\ts${i}\t+\t${next}\t+\t0M`].join('\n');
	}),
	`L\tr${SNPS - 1}\t+\tright\t+\t0M`
].join('\n');

describe('spread lanes layout, crowded stretches', () => {
	const layout = layoutOf(SNP_GFA, 'spread-lanes');
	const node = (seg: string) => layout.nodesById.get(layout.chains.find((c) => c.segId === seg)!.nodeIds[0])!;

	it('spreads a crowd sideways instead of stacking it over its anchors', () => {
		const rows = new Set(Array.from({ length: SNPS }, (_, i) => node(`s${i}`).y));
		expect(rows.size).toBeLessThan(SNPS / 2);
		// …in the same left-to-right order as the SNPs on the reference.
		for (let i = 1; i < SNPS; i++) expect(node(`s${i}`).x).toBeGreaterThan(node(`s${i - 1}`).x);
	});

	it('stacks the same crowd over its anchors in plain lanes', () => {
		const plain = layoutOf(SNP_GFA);
		const xs = Array.from({ length: SNPS }, (_, i) =>
			plain.nodesById.get(plain.chains.find((c) => c.segId === `s${i}`)!.nodeIds[0])!.x
		);
		expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(node('s9').x - node('s0').x);
	});

	it('leaves a lone bubble over its anchor', () => {
		const stat2 = layoutOf(STAT2, 'spread-lanes');
		const xs = stat2.chains.find((c) => c.segId === '41276770')!.nodeIds.map((id) => stat2.nodesById.get(id)!.x);
		const cut = stat2.nodesById.get(stat2.chains.find((c) => c.segId === 'u41276132')!.nodeIds.at(-1)!)!.x;
		expect(Math.min(...xs)).toBeLessThan(cut);
		expect(Math.max(...xs)).toBeGreaterThan(cut);
	});

	it('draws the spread connectors without crossings', () => {
		expect(crossings(layout)).toBe(0);
	});
});
