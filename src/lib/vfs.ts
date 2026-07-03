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
}

const BLOCK_SIZE = 1 << 16; // 64 KiB blocks: coarser than SQLite's 4 KiB pages, fewer requests.

/** Wraps a block-fetching source with an aligned block cache. */
abstract class BlockCachedReader implements RangeReader {
	abstract readonly size: number;
	private cache = new Map<number, Uint8Array>();
	requestCount = 0;
	bytesFetched = 0;

	/** Fetch bytes [start, end) from the underlying source synchronously. */
	protected abstract fetch(start: number, end: number): Uint8Array;

	private getBlock(index: number): Uint8Array {
		const cached = this.cache.get(index);
		if (cached) return cached;
		const start = index * BLOCK_SIZE;
		const end = Math.min(start + BLOCK_SIZE, this.size);
		const data = this.fetch(start, end);
		this.requestCount++;
		this.bytesFetched += data.length;
		this.cache.set(index, data);
		return data;
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
	readonly size: number;
	constructor(private url: string) {
		super();
		this.size = this.probeSize();
	}

	private probeSize(): number {
		const xhr = new XMLHttpRequest();
		xhr.open('GET', this.url, false);
		xhr.setRequestHeader('Range', 'bytes=0-0');
		xhr.send();
		if (xhr.status !== 206) {
			throw new Error(
				`Server does not support range requests (status ${xhr.status}). ` +
					`A 206 Partial Content response is required.`
			);
		}
		const contentRange = xhr.getResponseHeader('Content-Range'); // "bytes 0-0/12345"
		const total = contentRange && contentRange.split('/')[1];
		if (!total) throw new Error('Missing Content-Range header; cannot determine file size.');
		return Number(total);
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
