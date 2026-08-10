import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { computeBubbles } from './bubbles';

// Build a small reduced GFA by hand: a reference path 1→2→3 (100 bp each), a
// diamond bubble between 1 and 2 (two alternate alleles that share an exit node),
// and a skip edge from 1 to 3 (a deletion of the whole of node 2).
function seq(n: number): string {
	return 'A'.repeat(n);
}
const REDUCED = [
	'H\tVN:Z:1.1\tRS:Z:REF',
	`S\t1\t${seq(100)}\tWC:i:0`,
	`S\t2\t${seq(100)}\tWC:i:0`,
	`S\t3\t${seq(100)}\tWC:i:0`,
	// Diamond alt alleles: 10 (50 bp) and 11 (30 bp) both flow into 12 (20 bp).
	`S\t10\t${seq(50)}\tWC:i:5`,
	`S\t11\t${seq(30)}\tWC:i:3`,
	`S\t12\t${seq(20)}\tWC:i:8`,
	'W\tREF\t0\tchr1\t1000\t1300\t>1>2>3',
	'L\t1\t+\t2\t+\t0M',
	'L\t2\t+\t3\t+\t0M',
	'L\t1\t+\t10\t+\t0M',
	'L\t1\t+\t11\t+\t0M',
	'L\t10\t+\t12\t+\t0M',
	'L\t11\t+\t12\t+\t0M',
	'L\t12\t+\t2\t+\t0M',
	'L\t1\t+\t3\t+\t0M' // skip edge: deletes node 2
].join('\n');

describe('computeBubbles', () => {
	it('catalogues each non-reference component with its path extremes', () => {
		const model = computeBubbles(parseGfa(REDUCED), 'REF');
		expect(model).not.toBeNull();
		const m = model!;
		expect(m.contig).toBe('chr1');
		expect(m.genomicStart).toBe(1000);
		expect(m.refLen).toBe(300);

		const comp = m.bubbles.find((b) => !b.isSkip)!;
		// Attaches where node 1 ends (bp 100) and node 2 starts (bp 100) — a pure
		// insertion, so entry == exit and it spans no reference.
		expect(comp.entryBp).toBe(100);
		expect(comp.exitBp).toBe(100);
		expect(comp.refSpan).toBe(0);
		// Longest allele is 10→12 (50+20), shortest is 11→12 (30+20).
		expect(comp.longest).toBe(70);
		expect(comp.shortest).toBe(50);
		expect(comp.nodeCount).toBe(3);
		expect(comp.coverage).toBe(8); // max WC over its segments

		const skip = m.bubbles.find((b) => b.isSkip)!;
		// Jumps from the end of node 1 (100) to the start of node 3 (200): the
		// alternate path (the skip) takes no bases, so both path lengths are 0; the
		// reference span it replaces (100 bp) is the extent.
		expect(skip.entryBp).toBe(100);
		expect(skip.exitBp).toBe(200);
		expect(skip.refSpan).toBe(100);
		expect(skip.shortest).toBe(0);
		expect(skip.longest).toBe(0);
	});

	it('returns null when there is no reference walk', () => {
		expect(computeBubbles(parseGfa('H\tVN:Z:1.1'), 'REF')).toBeNull();
	});
});
