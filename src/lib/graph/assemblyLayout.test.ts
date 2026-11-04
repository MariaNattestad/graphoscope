import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { gfaToGraph } from './gfaToGraph';
import { foldGfa } from './fold';
import { buildAssemblyLayout, collapseChains, makeLengthMap } from './assemblyLayout';
import { buildAndRunLayout } from './forceLayout';
import { findExitEnds } from './exitCues';
import smn1 from './fixtures/smn1.gfa?raw';
import c4a from './fixtures/c4a.gfa?raw';

const A = (n: number) => 'A'.repeat(n);

// Ref 1→2→3→4→5, a 10 bp SNP-ish bubble 2/9 between 1 and 3, and a 40 bp
// deletion 3→5. Chains: 3→4 can't merge (3's end also carries the deletion);
// 4→5 can't (5's start carries it too); 1 branches; so nothing merges except the
// lone alt run 9→10.
const SMALL = [
	'H\tVN:Z:1.1',
	`S\t1\t${A(100)}`,
	`S\t2\t${A(10)}`,
	`S\t3\t${A(100)}`,
	`S\t4\t${A(40)}`,
	`S\t5\t${A(100)}`,
	`S\t9\t${A(6)}`,
	`S\t10\t${A(4)}`,
	'L\t1\t+\t2\t+\t0M',
	'L\t2\t+\t3\t+\t0M',
	'L\t3\t+\t4\t+\t0M',
	'L\t4\t+\t5\t+\t0M',
	'L\t1\t+\t9\t+\t0M',
	'L\t9\t+\t10\t+\t0M',
	'L\t10\t+\t3\t+\t0M',
	'L\t3\t+\t5\t+\t0M',
	'W\tREF\t0\tchr1\t0\t350\t>1>2>3>4>5',
	'W\thap\t1\tchr1\t0\t250\t>1>9>10>3>5'
].join('\n');

const graphOf = (text: string, ref = 'REF') => gfaToGraph(parseGfa(text), { referenceSample: ref }).graph;

describe('collapseChains', () => {
	it('merges unbranched runs, counting links per side', () => {
		const { graph, members } = collapseChains(graphOf(SMALL));
		expect(members.get('9')).toEqual(['9', '10']);
		expect(graph.segments.get('9')!.length).toBe(10);
		expect(members.get('3')).toEqual(['3']);
		expect(members.get('4')).toEqual(['4']);
		expect(graph.segments.size).toBe(6);
		expect(graph.links.some((l) => l.from === '9' && l.to === '3')).toBe(true);
	});

	it('reads links given in reverse (L b - a -) as the same run', () => {
		const g = graphOf(['H\tVN:Z:1.1', `S\ta\t${A(5)}`, `S\tb\t${A(5)}`, 'L\tb\t-\ta\t-\t0M', 'W\tREF\t0\tc\t0\t10\t>a>b'].join('\n'));
		expect(collapseChains(g).members.get('a')).toEqual(['a', 'b']);
	});
});

describe('makeLengthMap', () => {
	const bps = [1, 1, 1, 2, 5, 50, 3000];
	it('proportional sets the mean drawn length to about 40', () => {
		const many = [...bps, ...bps, ...bps, ...bps];
		const f = makeLengthMap(many, 'proportional');
		const mean = many.reduce((s, b) => s + f(b), 0) / many.length;
		expect(mean).toBeGreaterThan(38);
		expect(mean).toBeLessThan(60);
	});
	it('open and wide raise the minimum', () => {
		expect(makeLengthMap(bps, 'open')(1)).toBe(100);
		expect(makeLengthMap(bps, 'wide')(1)).toBe(400);
	});
	it('compress pulls extremes toward the mean', () => {
		const p = makeLengthMap(bps, 'proportional');
		const c = makeLengthMap(bps, 'compress');
		expect(c(3000) / c(1)).toBeLessThan(p(3000) / p(1));
		expect(c(1)).toBeGreaterThanOrEqual(8);
	});
	it('keeps the total at least 500', () => {
		const f = makeLengthMap([1, 1], 'proportional');
		expect(f(1) + f(1)).toBeCloseTo(500);
	});
});

describe('buildAssemblyLayout', () => {
	const refEnds = (layout: ReturnType<typeof buildAssemblyLayout>, first: string, last: string) => {
		const c1 = layout.chains.find((c) => c.segId === first)!;
		const c2 = layout.chains.find((c) => c.segId === last)!;
		return [layout.nodesById.get(c1.nodeIds[0])!, layout.nodesById.get(c2.nodeIds[c2.nodeIds.length - 1])!];
	};

	it('splits runs back into one chain per original segment', () => {
		const layout = buildAssemblyLayout(graphOf(SMALL), { referenceSample: 'REF' });
		expect(new Set(layout.chains.map((c) => c.segId))).toEqual(new Set(['1', '2', '3', '4', '5', '9', '10']));
		for (const n of layout.nodesById.values()) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
		expect(layout.assembly!.runs.map((r) => r.members)).toEqual([['9', '10']]);
	});

	it('routes the deletion through a hidden node and keeps it out of the plain links', () => {
		const layout = buildAssemblyLayout(graphOf(SMALL), { referenceSample: 'REF' });
		expect(layout.assembly!.routes).toHaveLength(1);
		expect(layout.assembly!.routes[0].skipBp).toBe(40);
		expect(layout.structuralLinkPaths.some((p) => p.from === '3' && p.to === '5')).toBe(false);
		const off = buildAssemblyLayout(graphOf(SMALL), { referenceSample: 'REF', assembly: { routeDeletions: false } });
		expect(off.assembly!.routes).toHaveLength(0);
		expect(off.structuralLinkPaths.some((p) => p.from === '3' && p.to === '5')).toBe(true);
	});

	it('runs the reference left to right', () => {
		const layout = buildAssemblyLayout(graphOf(SMALL), { referenceSample: 'REF' });
		const [a, b] = refEnds(layout, '1', '5');
		expect(b.x).toBeGreaterThan(a.x);
		expect(Math.abs(b.y - a.y)).toBeLessThan(1e-6);
	});

	it('is deterministic', () => {
		const g = foldGfa(parseGfa(c4a), 10, { referenceSample: 'GRCh38' }).gfa;
		const graph = gfaToGraph(g, { referenceSample: 'GRCh38' }).graph;
		const a = buildAndRunLayout(graph, { mode: 'assembly', referenceSample: 'GRCh38' });
		const b = buildAndRunLayout(graph, { mode: 'assembly', referenceSample: 'GRCh38' });
		expect([...a.nodesById.values()].map((n) => [n.x, n.y])).toEqual([...b.nodesById.values()].map((n) => [n.x, n.y]));
	});

	it('lays out a real unfolded locus with every part on and off', () => {
		const graph = gfaToGraph(parseGfa(smn1), { referenceSample: 'GRCh38' }).graph;
		for (const parts of [{}, { collapseChains: false, routeDeletions: false, anchorReference: false, lengthMap: 'proportional' as const }]) {
			const layout = buildAndRunLayout(graph, { mode: 'assembly', referenceSample: 'GRCh38', assembly: parts, iterations: 30 });
			expect(layout.chains.length).toBe(graph.segments.size);
			for (const n of layout.nodesById.values()) expect(Number.isFinite(n.x)).toBe(true);
		}
	});
});

describe('off-locus exit ends after splitting runs', () => {
	const exitKeys = (layout: ReturnType<typeof buildAssemblyLayout>) =>
		findExitEnds(layout)
			.map((e) => `${e.segId}@${layout.nodesById.get(e.nodeId)!.posIndex === 0 ? 'start' : 'end'}`)
			.sort();

	it('leaves no loose ends at the joins inside a collapsed run', () => {
		// The 9→10 alt run is linked at both outer ends: nothing leaves the locus, so
		// splitting it back into 9 and 10 must not leave 9's end / 10's start loose.
		const layout = buildAssemblyLayout(graphOf(SMALL), { referenceSample: 'REF', iterations: 20 });
		expect(layout.assembly!.runs.map((r) => r.members)).toEqual([['9', '10']]);
		expect(findExitEnds(layout)).toEqual([]);
	});

	it('marks one exit for a run chopped at the locus edge, not one per member', () => {
		// Alt run 7→8→9 leaves the reference at 1 and never comes back (cut off by the
		// window): only 9's far end is an exit.
		const chopped = [
			'H\tVN:Z:1.1',
			`S\t1\t${A(100)}`,
			`S\t2\t${A(100)}`,
			`S\t7\t${A(30)}`,
			`S\t8\t${A(30)}`,
			`S\t9\t${A(30)}`,
			'L\t1\t+\t2\t+\t0M',
			'L\t1\t+\t7\t+\t0M',
			'L\t7\t+\t8\t+\t0M',
			'L\t8\t+\t9\t+\t0M',
			'W\tREF\t0\tchr1\t0\t200\t>1>2',
			'W\thap\t1\tchr1\t0\t190\t>1>7>8>9'
		].join('\n');
		const layout = buildAssemblyLayout(graphOf(chopped), { referenceSample: 'REF', iterations: 20 });
		expect(layout.assembly!.runs.map((r) => r.members)).toEqual([['7', '8', '9']]);
		expect(exitKeys(layout)).toEqual(['9@end']);
	});

	it('gives the same exits with and without chain collapsing on real loci', () => {
		for (const fixture of [smn1, c4a]) {
			const graph = gfaToGraph(parseGfa(fixture), { referenceSample: 'GRCh38' }).graph;
			const opts = { referenceSample: 'GRCh38', iterations: 20 };
			const collapsed = buildAssemblyLayout(graph, opts);
			const plain = buildAssemblyLayout(graph, { ...opts, assembly: { collapseChains: false } });
			expect(collapsed.assembly!.runs.length).toBeGreaterThan(0);
			expect(exitKeys(collapsed)).toEqual(exitKeys(plain));
		}
	});
});
