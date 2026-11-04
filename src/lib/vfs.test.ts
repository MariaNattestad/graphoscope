import { describe, expect, it } from 'vitest';
import { BlockCachedReader } from './vfs';

const BLOCK = 1 << 16;

/** An in-memory source: byte i is i % 251, so any read can be checked. */
class FakeReader extends BlockCachedReader {
	readonly size = 64 * BLOCK;
	fetches: Array<[number, number]> = [];
	protected fetch(start: number, end: number): Uint8Array {
		this.fetches.push([start, end]);
		return Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251);
	}
	protected async fetchAsync(start: number, end: number): Promise<Uint8Array> {
		return this.fetch(start, end);
	}
}

const expected = (offset: number, length: number) =>
	Uint8Array.from({ length }, (_, i) => (offset + i) % 251);

describe('BlockCachedReader cache bound', () => {
	it('never holds more than its limit, and still reads correctly', () => {
		const r = new FakeReader();
		r.maxCacheBytes = 4 * BLOCK;
		// Random (non-sequential) reads, one block each, across the whole file.
		for (const b of [0, 10, 20, 30, 40, 50, 60, 5, 15]) {
			expect(r.readRange(b * BLOCK + 7, 100)).toEqual(expected(b * BLOCK + 7, 100));
			expect(r.cachedBytes).toBeLessThanOrEqual(4 * BLOCK);
		}
	});

	it('keeps recently used blocks and evicts the least recently used', () => {
		const r = new FakeReader();
		r.maxCacheBytes = 3 * BLOCK;
		r.readRange(0, 10); // block 0: the "header", touched by every query
		r.readRange(10 * BLOCK, 10);
		r.readRange(0, 10); // hit: block 0 becomes most recent
		r.readRange(20 * BLOCK, 10);
		r.readRange(30 * BLOCK, 10); // evicts block 10, not block 0
		const before = r.fetches.length;
		r.readRange(0, 10);
		expect(r.fetches.length).toBe(before); // still cached
		r.readRange(10 * BLOCK, 10);
		expect(r.fetches.length).toBe(before + 1); // was evicted
	});
});
