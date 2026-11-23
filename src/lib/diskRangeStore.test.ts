import { describe, expect, it } from 'vitest';
import { BLOCK, DiskRangeStore, validatorOf, type SyncHandle } from './diskRangeStore';
import { SparseRangeReader } from './sparseVfs';

/** An in-memory stand-in for an origin-private file's sync access handle. */
class MemHandle implements SyncHandle {
	bytes = new Uint8Array(0);
	read(buffer: Uint8Array, { at }: { at: number }) {
		const part = this.bytes.subarray(at, at + buffer.length);
		buffer.set(part);
		return part.length;
	}
	write(buffer: Uint8Array, { at }: { at: number }) {
		if (at + buffer.length > this.bytes.length) {
			const grown = new Uint8Array(at + buffer.length);
			grown.set(this.bytes);
			this.bytes = grown;
		}
		this.bytes.set(buffer, at);
		return buffer.length;
	}
	getSize() {
		return this.bytes.length;
	}
	truncate(size: number) {
		this.bytes = this.bytes.slice(0, size);
	}
	flush() {}
	close() {}
}

const SIZE = 200 * BLOCK + 123; // past the read-ahead; the last block is short
const file = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7) % 251);

/** A reader over `file` that counts what it asks the "host" for. */
function reader(disk: DiskRangeStore | null) {
	const asked: [number, number][] = [];
	const r = new SparseRangeReader(SIZE, async (start, end) => {
		asked.push([start, end]);
		return file.slice(start, end);
	});
	r.disk = disk;
	return { r, asked };
}

async function read(r: SparseRangeReader, offset: number, length: number) {
	r.readRange(offset, length);
	await r.fetchWanted();
	return r.readRange(offset, length);
}

describe('DiskRangeStore', () => {
	it('serves a second visit from disk, the short last block included', async () => {
		const data = new MemHandle();
		const index = new MemHandle();
		const first = reader(new DiskRangeStore(data, index, 'https://host/x', '1:a'));
		expect(await read(first.r, 5 * BLOCK + 10, 100)).toEqual(file.slice(5 * BLOCK + 10, 5 * BLOCK + 110));
		expect(await read(first.r, SIZE - 50, 50)).toEqual(file.slice(SIZE - 50));
		expect(first.asked.length).toBeGreaterThan(0);
		first.r.flush();

		const second = reader(new DiskRangeStore(data, index, 'https://host/x', '1:a'));
		expect(await read(second.r, 5 * BLOCK + 10, 100)).toEqual(file.slice(5 * BLOCK + 10, 5 * BLOCK + 110));
		expect(await read(second.r, SIZE - 50, 50)).toEqual(file.slice(SIZE - 50));
		expect(second.asked).toEqual([]);
		expect(second.r.diskHits).toBeGreaterThan(0);
	});

	it('fetches only the blocks it has not kept', async () => {
		const data = new MemHandle();
		const index = new MemHandle();
		const first = reader(new DiskRangeStore(data, index, 'https://host/x', '1:a'));
		// A lone read is fetched with read-ahead: up to the end of `kept`.
		await read(first.r, 2 * BLOCK, BLOCK);
		first.r.flush();
		const kept = first.asked[0][1];
		const second = reader(new DiskRangeStore(data, index, 'https://host/x', '1:a'));
		expect(await read(second.r, kept - BLOCK, 2 * BLOCK)).toEqual(file.slice(kept - BLOCK, kept + BLOCK));
		expect(second.asked[0][0]).toBe(kept);
	});

	it('starts over when the file changed on the host, or the name is another file', async () => {
		const data = new MemHandle();
		const index = new MemHandle();
		const first = reader(new DiskRangeStore(data, index, 'https://host/x', '1:a'));
		await read(first.r, 0, 100);
		first.r.flush();
		const changed = reader(new DiskRangeStore(data, index, 'https://host/x', '1:b'));
		await read(changed.r, 0, 100);
		expect(changed.asked.length).toBe(1);
		const other = reader(new DiskRangeStore(data, index, 'https://host/y', '1:a'));
		await read(other.r, 0, 100);
		expect(other.asked.length).toBe(1);
	});

	it('trusts a file only with a validator', () => {
		expect(validatorOf(9, new Headers({ ETag: '"abc"' }))).toBe('9:"abc"');
		expect(validatorOf(9, new Headers({ 'Last-Modified': 'Thu, 19 Nov 2026 19:56:41 GMT' }))).toMatch(/^9:Thu/);
		expect(validatorOf(9, new Headers())).toBeNull();
	});
});
