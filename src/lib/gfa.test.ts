import { describe, expect, it } from 'vitest';
import { parseGfa, gfaStats, gfaLightStats, filterToReferenceWalks } from './gfa';
import { ALL_FIXTURES } from './graph/fixtures';

describe('gfaLightStats', () => {
	it('matches gfaStats(parseGfa(text)) exactly, across every fixture', () => {
		for (const fixture of ALL_FIXTURES) {
			const full = gfaStats(parseGfa(fixture.gfaText));
			const light = gfaLightStats(fixture.gfaText);
			expect(light, fixture.id).toEqual(full);
		}
	});

	it('handles an empty string', () => {
		expect(gfaLightStats('')).toEqual({
			segments: 0,
			links: 0,
			walks: 0,
			totalSequenceBp: 0,
			samples: 0
		});
	});

	it('handles a file with no trailing newline', () => {
		const text = 'H\tVN:Z:1.1\nS\t1\tACGT\nL\t1\t+\t2\t+\t*\nW\tGRCh38\t0\tchr1\t0\t4\t>1';
		const stats = gfaLightStats(text);
		expect(stats.segments).toBe(1);
		expect(stats.links).toBe(1);
		expect(stats.walks).toBe(1);
		expect(stats.totalSequenceBp).toBe(4);
		expect(stats.samples).toBe(1);
	});

	it('counts total sequence bp correctly across multiple segments', () => {
		const text = 'S\ta\tACGT\nS\tb\tAC\nS\tc\tACGTACGT\n';
		expect(gfaLightStats(text).totalSequenceBp).toBe(4 + 2 + 8);
	});

	it('dedupes sample names the same way gfaStats does', () => {
		const text = [
			'W\tGRCh38\t0\tchr1\t0\t10\t>1>2',
			'W\tHG002\t1\tchr1\t0\t10\t>1>2',
			'W\tHG002\t2\tchr1\t0\t10\t>1>2',
			''
		].join('\n');
		expect(gfaLightStats(text).samples).toBe(2);
		expect(gfaLightStats(text).walks).toBe(3);
	});
});

describe('filterToReferenceWalks', () => {
	it('keeps every segment/link and only the reference walk, across every fixture', () => {
		for (const fixture of ALL_FIXTURES) {
			const filtered = filterToReferenceWalks(fixture.gfaText, fixture.referenceSample);
			const before = gfaStats(parseGfa(fixture.gfaText));
			const after = gfaStats(parseGfa(filtered));
			expect(after.segments, fixture.id).toBe(before.segments);
			expect(after.links, fixture.id).toBe(before.links);
			expect(after.samples, fixture.id).toBe(1);
			expect(after.walks, fixture.id).toBeGreaterThan(0);
			// Every walk left standing must actually belong to the reference sample.
			const parsed = parseGfa(filtered);
			for (const w of parsed.walks) expect(w.sample, fixture.id).toBe(fixture.referenceSample);
		}
	});

	it('is a no-op on lines other than W (headers/segments/links pass through as-is)', () => {
		const text = 'H\tVN:Z:1.1\nS\t1\tACGT\nL\t1\t+\t2\t+\t*\n';
		expect(filterToReferenceWalks(text, 'GRCh38')).toBe(text);
	});

	it('drops non-reference walks and keeps the reference one intact', () => {
		const text = [
			'S\t1\tACGT',
			'W\tGRCh38\t0\tchr1\t0\t4\t>1',
			'W\tHG002\t1\tchr1\t0\t4\t>1',
			'W\tHG002\t2\tchr1\t0\t4\t>1',
			''
		].join('\n');
		const filtered = filterToReferenceWalks(text, 'GRCh38');
		expect(filtered).toBe('S\t1\tACGT\nW\tGRCh38\t0\tchr1\t0\t4\t>1\n');
	});

	it('handles no matching reference sample by dropping all walks', () => {
		const text = 'S\t1\tACGT\nW\tHG002\t1\tchr1\t0\t4\t>1\n';
		expect(filterToReferenceWalks(text, 'GRCh38')).toBe('S\t1\tACGT\n');
	});

	it('handles an empty string', () => {
		expect(filterToReferenceWalks('', 'GRCh38')).toBe('\n');
	});
});
