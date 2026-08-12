import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { computeAssemblyStats } from './assemblyStats';
import { rgfaBackbone } from './rgfaBackbone';

describe('computeAssemblyStats', () => {
	it('counts components, dead-ends, self-loops and N50', () => {
		// Component A: 1—2—3 linear chain (two tips: 1 and 3). Node lengths 300/100/300.
		// Component B: an isolated node 9 (no links). Plus a self-loop on node 2.
		const gfa = parseGfa(
			[
				'S\t1\t' + 'A'.repeat(300),
				'S\t2\t' + 'A'.repeat(100),
				'S\t3\t' + 'A'.repeat(300),
				'S\t9\t' + 'A'.repeat(50),
				'L\t1\t+\t2\t+\t0M',
				'L\t2\t+\t3\t+\t0M',
				'L\t2\t+\t2\t+\t0M' // self-loop
			].join('\n')
		);
		const s = computeAssemblyStats(gfa);
		expect(s.segments).toBe(4);
		expect(s.components).toBe(2); // {1,2,3} and {9}
		expect(s.selfLoops).toBe(1);
		expect(s.isolated).toBe(1); // node 9
		expect(s.deadEnds).toBe(2); // nodes 1 and 3 (one free end each)
		expect(s.largestComponentFraction).toBeCloseTo(3 / 4);
		// Total bp 750; sorted 300,300,100,50 → cumulative 300 (<375), 600 (≥375) → N50 300.
		expect(s.totalBp).toBe(750);
		expect(s.n50).toBe(300);
		expect(s.depth).toBeNull();
	});

	it('summarises depth from dp / KC / RC tags', () => {
		const gfa = parseGfa(
			[
				'S\t1\tACGT\tdp:f:10.0',
				'S\t2\tACGT\tdp:f:20.0',
				'S\t3\tACGT\tdp:f:30.0'
			].join('\n')
		);
		const s = computeAssemblyStats(gfa);
		expect(s.depth).not.toBeNull();
		expect(s.depth!.unit).toBe('x');
		expect(s.depth!.min).toBe(10);
		expect(s.depth!.median).toBe(20);
		expect(s.depth!.max).toBe(30);
		expect(s.depth!.covered).toBe(3);
	});

	it('reads read-count depth (RC) as reads', () => {
		const gfa = parseGfa(['S\t1\tACGT\tLN:i:4\tRC:i:5117'].join('\n'));
		expect(gfa.segments.get('1')?.depth).toBe(5117);
		expect(computeAssemblyStats(gfa).depth?.unit).toBe('reads');
	});
});

describe('rgfaBackbone', () => {
	it('builds a reference backbone from rank-0 SN/SO/SR tags', () => {
		// rGFA: rank-0 reference (segments r1,r2,r3 on chrX by offset) plus an inserted
		// rank-1 allele (a1) that should be excluded from the backbone.
		const gfa = parseGfa(
			[
				'S\tr2\t' + 'A'.repeat(100) + '\tSN:Z:chrX\tSO:i:100\tSR:i:0',
				'S\tr1\t' + 'A'.repeat(100) + '\tSN:Z:chrX\tSO:i:0\tSR:i:0',
				'S\tr3\t' + 'A'.repeat(100) + '\tSN:Z:chrX\tSO:i:200\tSR:i:0',
				'S\ta1\t' + 'A'.repeat(20) + '\tSN:Z:sample1\tSO:i:0\tSR:i:1',
				'L\tr1\t+\tr2\t+\t0M',
				'L\tr2\t+\tr3\t+\t0M'
			].join('\n')
		);
		const bb = rgfaBackbone(gfa);
		expect(bb).not.toBeNull();
		expect(bb!.contig).toBe('chrX');
		expect(bb!.start).toBe(0);
		expect(bb!.bp).toBe(300);
		expect(bb!.steps.map((s) => s.id)).toEqual(['r1', 'r2', 'r3']); // ordered by SO
	});

	it('extends the backbone through an untagged root segment (gfatools MT style)', () => {
		// root (untagged) → r1 → r2, where r1/r2 are rank-0 at offsets 100/200 and the
		// root is the untagged 100 bp start. The backbone should include the root and
		// start at 0.
		const gfa = parseGfa(
			[
				'S\troot\t' + 'A'.repeat(100),
				'S\tr1\t' + 'A'.repeat(100) + '\tSN:Z:chrX\tSO:i:100\tSR:i:0',
				'S\tr2\t' + 'A'.repeat(100) + '\tSN:Z:chrX\tSO:i:200\tSR:i:0',
				'L\troot\t+\tr1\t+\t0M',
				'L\tr1\t+\tr2\t+\t0M'
			].join('\n')
		);
		const bb = rgfaBackbone(gfa)!;
		expect(bb.steps.map((s) => s.id)).toEqual(['root', 'r1', 'r2']);
		expect(bb.start).toBe(0);
		expect(bb.bp).toBe(300);
	});

	it('returns null when there are no rank-0 stable tags', () => {
		const gfa = parseGfa(['S\t1\tACGT', 'S\t2\tACGT', 'L\t1\t+\t2\t+\t0M'].join('\n'));
		expect(rgfaBackbone(gfa)).toBeNull();
	});
});
