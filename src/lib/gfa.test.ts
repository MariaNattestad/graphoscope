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

	it('takes segment length from the LN tag when the sequence is elided', () => {
		// rGFA / assembler style: sequence stored elsewhere, length in LN:i.
		const gfa = parseGfa(['S\ts1\t*\tLN:i:5000', 'S\ts2\tACGT'].join('\n'));
		expect(gfa.segments.get('s1')?.length).toBe(5000);
		expect(gfa.segments.get('s1')?.seq).toBe('');
		// A real sequence still wins over any (redundant) LN tag.
		expect(gfa.segments.get('s2')?.length).toBe(4);
		expect(gfaStats(gfa).totalSequenceBp).toBe(5004);
	});

	it('parses P-lines (GFA 1.0 paths) into walks with a bp span', () => {
		const text = [
			'H\tVN:Z:1.0',
			'S\t1\tCAAATAAG', // 8 bp
			'S\t2\tA', // 1 bp
			'S\t3\tCCAACTCTCTG', // 11 bp
			'P\tx\t1+,2-,3+\t8M,1M,11M',
			'L\t1\t+\t2\t+\t0M',
			'L\t2\t+\t3\t+\t0M'
		].join('\n');
		const gfa = parseGfa(text);
		expect(gfa.walks).toHaveLength(1);
		const p = gfa.walks[0];
		expect(p.kind).toBe('P');
		expect(p.sample).toBe('x');
		expect(p.seqId).toBe('x');
		expect(p.steps).toEqual([
			{ id: '1', orient: '+' },
			{ id: '2', orient: '-' },
			{ id: '3', orient: '+' }
		]);
		// bp span comes from summed segment lengths (P-lines carry no coordinates).
		expect(p.end - p.start).toBe(20);
		expect(gfaStats(gfa, 'x').referencePathBp).toBe(20);
	});
});
