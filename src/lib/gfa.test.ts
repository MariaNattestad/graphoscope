import { describe, expect, it } from 'vitest';
import { parseGfa, gfaStats } from './gfa';
import { ALL_FIXTURES } from './graph/fixtures';

describe('parseGfa + gfaStats', () => {
	it('parses every fixture consistently with its own stats', () => {
		for (const fixture of ALL_FIXTURES) {
			const gfa = parseGfa(fixture.gfaText);
			const stats = gfaStats(gfa, fixture.referenceSample);
			expect(stats.segments, fixture.id).toBe(gfa.segments.size);
			expect(stats.links, fixture.id).toBe(gfa.links.length);
			expect(stats.walks, fixture.id).toBe(gfa.walks.length);
			expect(stats.samples, fixture.id).toBe(new Set(gfa.walks.map((w) => w.sample)).size);
			let bp = 0;
			for (const s of gfa.segments.values()) bp += s.length;
			expect(stats.totalSequenceBp, fixture.id).toBe(bp);
		}
	});

	it('reads the reference path span from the reference walk', () => {
		const text = ['H\tVN:Z:1.1\tRS:Z:GRCh38', 'S\t1\tACGT', 'W\tGRCh38\t0\tchr1\t100\t150\t>1'].join(
			'\n'
		);
		expect(gfaStats(parseGfa(text), 'GRCh38').referencePathBp).toBe(50);
		// Null when the named sample has no walk here.
		expect(gfaStats(parseGfa(text), 'HG002').referencePathBp).toBeNull();
	});

	it('ignores unknown record types', () => {
		const gfa = parseGfa(['S\t1\tACGT', 'Q\tsomething\telse', 'S\t2\tGG'].join('\n'));
		expect(gfa.segments.size).toBe(2);
	});
});
