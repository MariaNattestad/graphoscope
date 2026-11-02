// Range-request virtual filesystem for the GBZ-base SQLite DB.
//
// `query.wasm` (WASI) reads the database through synchronous `fd_read`/`fd_pread`
// calls. SQLite only touches the handful of 4 KiB pages a query needs, so if we
// back those reads with HTTP range requests (or slices of a local File) instead
// of a full in-memory buffer, the browser never downloads the whole multi-GB DB.
//
// This module must run inside a Web Worker: it relies on synchronous XHR and
// FileReaderSync, which are only available off the main thread.

import { File as WasiFile, OpenFile, wasi } from '@bjorn3/browser_wasi_shim';

/** A source that can be read synchronously at arbitrary byte offsets. */
export interface RangeReader {
	readonly size: number;
	/** Read up to `length` bytes at `offset` (clamped to EOF). */
	readRange(offset: number, length: number): Uint8Array;
	/** Number of underlying fetches performed (for diagnostics). */
	readonly requestCount: number;
	readonly bytesFetched: number;
	/** Fetch [offset, offset + length) into the cache ahead of time, as one
	 * asynchronous request. Lets independent reads run in parallel before the
	 * (strictly serial) synchronous query starts. */
	prefetch(offset: number, length: number): Promise<void>;
}

const BLOCK_SIZE = 1 << 16; // 64 KiB blocks: coarser than SQLite's 4 KiB pages, fewer requests.
// Adaptive readahead: on a run of sequential block misses we widen the fetch
// window exponentially (1 → 4 → 16 … blocks) up to this many blocks in a single
// request. Latency (round-trip time), not bandwidth, dominates when the DB is on
// a remote host (~300 ms to first byte from S3, vs ~70 ms per extra MiB), so
// coalescing a clustered scan into one big range request is a large win; random
// single-page reads still fetch exactly one block.
const MAX_READAHEAD_SHIFT = 5; // up to 2^5 = 32 blocks = 2 MiB per request
const READAHEAD_STEP = 2; // shift added per sequential miss: the window quadruples

/** Wraps a block-fetching source with an aligned block cache + readahead. */
abstract class BlockCachedReader implements RangeReader {
	abstract readonly size: number;
	private cache = new Map<number, Uint8Array>();
	// Readahead state: the block index we'd expect next if access is sequential,
	// and how long the current sequential run is (drives the window size).
	private expectedNextBlock = -1;
	private seqRun = 0;
	requestCount = 0;
	bytesFetched = 0;

	/** Fetch bytes [start, end) from the underlying source synchronously. */
	protected abstract fetch(start: number, end: number): Uint8Array;

	private getBlock(index: number): Uint8Array {
		const cached = this.cache.get(index);
		if (cached) return cached;

		// Grow the readahead window while misses keep arriving in sequence;
		// reset to a single block on a non-sequential (random) miss. A miss right
		// after a cached block also counts as sequential: a scan that ran into a
		// block fetched earlier (e.g. a B-tree's root page sitting among its own
		// leaves) resumes past it rather than starting over from one block.
		let windowBlocks = 1;
		if (index === this.expectedNextBlock || this.cache.has(index - 1)) {
			this.seqRun = Math.min(this.seqRun + READAHEAD_STEP, MAX_READAHEAD_SHIFT);
			windowBlocks = 1 << this.seqRun;
		} else {
			this.seqRun = 0;
		}

		// Fetch a contiguous run of *uncached* blocks starting at `index`, so a
		// widened window never re-downloads pages we already hold.
		const totalBlocks = Math.ceil(this.size / BLOCK_SIZE);
		let endBlock = index + 1;
		while (endBlock < index + windowBlocks && endBlock < totalBlocks && !this.cache.has(endBlock)) {
			endBlock++;
		}

		const start = index * BLOCK_SIZE;
		const end = Math.min(endBlock * BLOCK_SIZE, this.size);
		const data = this.fetch(start, end);
		this.requestCount++;
		this.bytesFetched += data.length;

		for (let b = index; b < endBlock; b++) {
			const sliceStart = (b - index) * BLOCK_SIZE;
			this.cache.set(b, data.subarray(sliceStart, Math.min(sliceStart + BLOCK_SIZE, data.length)));
		}
		this.expectedNextBlock = endBlock;
		return this.cache.get(index)!;
	}

	/** Fetch bytes [start, end) asynchronously (for prefetching). */
	protected abstract fetchAsync(start: number, end: number): Promise<Uint8Array>;

	/** Store an aligned run of blocks starting at block `first`. */
	protected store(first: number, data: Uint8Array) {
		for (let b = first, off = 0; off < data.length; b++, off += BLOCK_SIZE) {
			this.cache.set(b, data.subarray(off, Math.min(off + BLOCK_SIZE, data.length)));
		}
	}

	async prefetch(offset: number, length: number): Promise<void> {
		const end = Math.min(offset + length, this.size);
		let first = Math.floor(offset / BLOCK_SIZE);
		let last = Math.ceil(end / BLOCK_SIZE) - 1;
		// Trim cached blocks off both ends; a cached block in the middle is simply
		// fetched again, which beats splitting into two round trips.
		while (first <= last && this.cache.has(first)) first++;
		while (last >= first && this.cache.has(last)) last--;
		if (first > last) return;
		const data = await this.fetchAsync(first * BLOCK_SIZE, Math.min((last + 1) * BLOCK_SIZE, this.size));
		this.requestCount++;
		this.bytesFetched += data.length;
		this.store(first, data);
	}

	readRange(offset: number, length: number): Uint8Array {
		if (offset >= this.size) return new Uint8Array(0);
		const end = Math.min(offset + length, this.size);
		const out = new Uint8Array(end - offset);
		let pos = offset;
		while (pos < end) {
			const blockIndex = Math.floor(pos / BLOCK_SIZE);
			const block = this.getBlock(blockIndex);
			const blockStart = blockIndex * BLOCK_SIZE;
			const within = pos - blockStart;
			const take = Math.min(block.length - within, end - pos);
			out.set(block.subarray(within, within + take), pos - offset);
			pos += take;
			if (take <= 0) break; // guard against a short final block
		}
		return out;
	}
}

/** Reads the DB from a remote URL via synchronous HTTP range requests. */
export class HttpRangeReader extends BlockCachedReader {
	private constructor(
		private url: string,
		readonly size: number
	) {
		super();
	}

	/** Opens a remote DB. The first block (SQLite header + schema page) doubles
	 * as the size probe, so opening costs one round trip and leaves the header
	 * cached for the query. */
	static async open(url: string): Promise<HttpRangeReader> {
		const res = await fetch(url, { headers: { Range: `bytes=0-${BLOCK_SIZE - 1}` } });
		if (res.status !== 206) {
			throw new Error(
				`Server does not support range requests (status ${res.status}). ` +
					`A 206 Partial Content response is required.`
			);
		}
		const contentRange = res.headers.get('Content-Range'); // "bytes 0-65535/12345"
		const total = contentRange && contentRange.split('/')[1];
		if (!total) throw new Error('Missing Content-Range header; cannot determine file size.');
		const data = new Uint8Array(await res.arrayBuffer());
		const reader = new HttpRangeReader(url, Number(total));
		reader.requestCount++;
		reader.bytesFetched += data.length;
		reader.store(0, data);
		return reader;
	}

	protected async fetchAsync(start: number, end: number): Promise<Uint8Array> {
		const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
		// 206 only: a 200 would be the whole multi-GB file, not the slice we asked for.
		if (res.status !== 206) throw new Error(`Range request failed with status ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}

	protected fetch(start: number, end: number): Uint8Array {
		const xhr = new XMLHttpRequest();
		xhr.open('GET', this.url, false);
		xhr.responseType = 'arraybuffer'; // allowed for sync XHR inside a Worker
		xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
		xhr.send();
		if (xhr.status !== 206 && xhr.status !== 200) {
			throw new Error(`Range request failed with status ${xhr.status}`);
		}
		return new Uint8Array(xhr.response as ArrayBuffer);
	}
}

/** Reads the DB from a local File (drag-drop / file picker) via FileReaderSync. */
export class BlobRangeReader extends BlockCachedReader {
	readonly size: number;
	private reader = new FileReaderSync();
	constructor(private file: Blob) {
		super();
		this.size = file.size;
	}
	protected fetch(start: number, end: number): Uint8Array {
		const buf = this.reader.readAsArrayBuffer(this.file.slice(start, end));
		return new Uint8Array(buf);
	}
	protected async fetchAsync(start: number, end: number): Promise<Uint8Array> {
		return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
	}
}

// --- WASI filesystem glue -------------------------------------------------

/**
 * A WASI inode whose contents are served lazily by a RangeReader instead of an
 * in-memory Uint8Array. Plugged into a PreopenDirectory so `query.wasm` can
 * `open()` it by path.
 */
export class LazyFile extends WasiFile {
	constructor(public reader: RangeReader) {
		super(new Uint8Array(0), { readonly: true });
	}
	get size(): bigint {
		return BigInt(this.reader.size);
	}
	stat() {
		return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, this.size);
	}
	path_open(oflags: number, fs_rights_base: bigint, fd_flags: number) {
		return { ret: wasi.ERRNO_SUCCESS, fd_obj: new LazyOpenFile(this) };
	}
}

class LazyOpenFile extends OpenFile {
	declare file: LazyFile;
	constructor(file: LazyFile) {
		super(file);
	}
	fd_read(size: number) {
		const off = Number(this.file_pos);
		const data = this.file.reader.readRange(off, size);
		this.file_pos += BigInt(data.length);
		return { ret: 0, data };
	}
	fd_pread(size: number, offset: bigint) {
		const data = this.file.reader.readRange(Number(offset), size);
		return { ret: 0, data };
	}
	fd_seek(offset: bigint, whence: number) {
		let next: bigint;
		switch (whence) {
			case wasi.WHENCE_SET:
				next = offset;
				break;
			case wasi.WHENCE_CUR:
				next = this.file_pos + offset;
				break;
			case wasi.WHENCE_END:
				next = this.file.size + offset;
				break;
			default:
				return { ret: wasi.ERRNO_INVAL, offset: 0n };
		}
		if (next < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
		this.file_pos = next;
		return { ret: 0, offset: this.file_pos };
	}
	fd_filestat_get() {
		return { ret: 0, filestat: this.file.stat() };
	}
}
