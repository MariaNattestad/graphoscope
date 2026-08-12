import { describe, expect, it } from 'vitest';
import { computeLongestPath } from './longestPath';

// Tiny segment/link builders — `computeLongestPath` only reads segment lengths
// and link endpoints, so we don't need full Gfa objects here.
function segs(lengths: Record<string, number>): Map<string, { length: number }> {
	return new Map(Object.entries(lengths).map(([id, length]) => [id, { length }]));
}
function links(pairs: [string, string][]): { from: string; to: string }[] {
	return pairs.map(([from, to]) => ({ from, to }));
}

describe('computeLongestPath', () => {
	it('returns null for an empty graph', () => {
		expect(computeLongestPath(segs({}), links([]))).toBeNull();
	});

	it('follows a simple chain end to end', () => {
		const path = computeLongestPath(segs({ a: 10, b: 20, c: 5 }), links([['a', 'b'], ['b', 'c']]));
		expect(path?.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
		expect(path?.bp).toBe(35);
	});

	it('prefers the heavier branch through a bubble', () => {
		// a → {b(50) | c(5)} → d. The longest path threads the 50 bp allele.
		const path = computeLongestPath(
			segs({ a: 100, b: 50, c: 5, d: 100 }),
			links([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
		);
		expect(path?.steps.map((s) => s.id)).toEqual(['a', 'b', 'd']);
		expect(path?.bp).toBe(250);
	});

	it('terminates and produces a path on a cyclic graph', () => {
		// a → b → c → a is a cycle; the back-edge (c→a) is dropped, so the DP still
		// finds a longest simple spine rather than looping forever.
		const path = computeLongestPath(
			segs({ a: 10, b: 10, c: 10 }),
			links([['a', 'b'], ['b', 'c'], ['c', 'a']])
		);
		expect(path).not.toBeNull();
		const ids = path!.steps.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length); // no node visited twice
		expect(ids.length).toBe(3);
		expect(path!.bp).toBe(30);
	});

	it('ignores self-loops (as in gfatools MT.gfa)', () => {
		const path = computeLongestPath(
			segs({ a: 10, b: 20 }),
			links([['a', 'a'], ['a', 'b'], ['b', 'b']])
		);
		expect(path?.steps.map((s) => s.id)).toEqual(['a', 'b']);
		expect(path?.bp).toBe(30);
	});

	it('refuses graphs larger than the node cap', () => {
		expect(computeLongestPath(segs({ a: 1, b: 1, c: 1 }), links([['a', 'b']]), 2)).toBeNull();
	});

	it('handles a long linear chain without recursing (no stack overflow)', () => {
		const lengths: Record<string, number> = {};
		const pairs: [string, string][] = [];
		const N = 50000;
		for (let i = 0; i < N; i++) lengths[`n${i}`] = 1;
		for (let i = 0; i + 1 < N; i++) pairs.push([`n${i}`, `n${i + 1}`]);
		const path = computeLongestPath(segs(lengths), links(pairs), N);
		expect(path?.steps.length).toBe(N);
		expect(path?.bp).toBe(N);
	});
});
