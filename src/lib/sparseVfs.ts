// Remote files for a wasm query that makes many small, scattered reads.
//
// The GBZ query (vfs.ts) reads an SQLite database: a handful of clustered
// pages, fetched one synchronous request at a time. A gfaidx query is another
// shape. For a region it reads a few bytes per haplotype (where that
// haplotype's steps are, then the steps), each from its own corner of a
// multi-GB file: hundreds of reads of a few hundred bytes. One synchronous
// round trip each would take a minute from a bucket.
//
// So the query is run as a plan first. A read of bytes not yet fetched is
// answered with zeros and written down; the run carries on, or fails, on the
// zeros, and either way it has named every read that did not depend on a
// missing one. Those are fetched together, in parallel, and the query is run
// again. A run that misses nothing saw only real bytes, and its output is the
// answer. Reads that depend on each other (a header, then the table it points
// to, then an entry) take one round per level, so a query costs a few round
// trips' worth of waiting, however many reads it makes.
//
// Exact ranges are fetched, not fixed blocks: of a 64 KiB block around a
// 200-byte read, nearly all would be another haplotype's data.

import { File as WasiFile, OpenFile, wasi } from '@bjorn3/browser_wasi_shim';

/** Fetch bytes [start, end) of the file. */
export type RangeFetcher = (start: number, end: number) => Promise<Uint8Array>;

// A wanted range is widened to this grain, so reads next to each other (the
// next few entries of a table) come along and are not a round of their own.
const GRAIN = 4096;
// When a round found only a few reads in a file, the run was stopped short:
// something is being read in order (posting blocks one after another, the
// graph's gzip members) and the run failed on the first one that was zeros.
// The rest of that sequence lies just ahead, so a lone read is fetched with
// this much after it. A round with hundreds of reads (one per haplotype) gets
// none: a round trip costs more than these bytes, a wasted megabyte per
// haplotype costs more than a round trip.
const AHEAD_BUDGET = 512 * 1024;
const AHEAD_MAX = 256 * 1024;
// Each file's head and tail are fetched when it is opened: headers and the
// tables they point to (which several of these formats keep at the end).
const SEED = 64 * 1024;
// Ranges this close are fetched as one request: a request costs more than 16 KiB.
const JOIN_GAP = 16 * 1024;
const MAX_PARALLEL = 12;
// A run on zeros can ask for nonsense. These bound what one round may fetch.
const MAX_ROUND_BYTES = 256 * 1024 * 1024;
const MAX_ROUND_RANGES = 20_000;
// A single read longer than this is a run on zeros asking for nonsense (a
// length read from bytes that weren't there). It is not fetched.
const MAX_ONE_READ = 64 * 1024 * 1024;
// What one reader keeps in memory; past it the oldest pieces are dropped.
const MAX_HELD_BYTES = 384 * 1024 * 1024;

// Every read noted, in the order the run asked for them, across all files.
// The run read real bytes up to its first miss, so the earliest misses are
// genuine; later ones may come from a run gone astray on zeros.
let wantSequence = 0;
// After an overflow, how many of the earliest misses are fetched.
const AFTER_OVERFLOW = 64;

/** Thrown out of a plan run that has asked for more than a round may fetch. */
export class PlanOverflow extends Error {
	constructor() {
		super('The query asked for more of the index than one round may fetch.');
	}
}

/** The bytes of a remote file fetched so far, served synchronously. */
export class SparseRangeReader {
	requestCount = 0;
	bytesFetched = 0;
	// Fetched pieces: sorted by start, never overlapping or touching (touching
	// ones are joined), so a read is inside one piece or it is a miss.
	private starts: number[] = [];
	private pieces: Uint8Array[] = [];
	private held = 0;
	private wanted: [number, number][] = [];
	private wantedOrder: number[] = [];
	private wantedBytes = 0;
	/** Reads of the current run that were too long to be meant. */
	oversize = 0;

	constructor(
		readonly size: number,
		private fetchRange: RangeFetcher
	) {}

	/** Index of the piece that starts at or before `offset`, or -1. */
	private pieceAt(offset: number): number {
		let lo = 0;
		let hi = this.starts.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.starts[mid] <= offset) lo = mid + 1;
			else hi = mid;
		}
		return lo - 1;
	}

	private has(offset: number, end: number): boolean {
		const i = this.pieceAt(offset);
		return i >= 0 && this.starts[i] + this.pieces[i].length >= end;
	}

	/** Bytes [offset, offset + length), clamped to the file. Bytes not fetched
	 * yet come back as zeros, and are noted for the next round. */
	readRange(offset: number, length: number): Uint8Array {
		const end = Math.min(offset + length, this.size);
		if (!(end > offset)) return new Uint8Array(0);
		const i = this.pieceAt(offset);
		if (i >= 0 && this.starts[i] + this.pieces[i].length >= end) {
			const from = offset - this.starts[i];
			return this.pieces[i].slice(from, from + (end - offset));
		}
		this.want(offset, end);
		return new Uint8Array(end - offset);
	}

	/** Note that [offset, end) will be read, without reading it. */
	want(offset: number, end: number) {
		end = Math.min(end, this.size);
		if (!(end > offset) || this.has(offset, end)) return;
		if (end - offset > MAX_ONE_READ) {
			this.oversize++;
			return;
		}
		this.wanted.push([offset, end]);
		this.wantedOrder.push(wantSequence++);
		this.wantedBytes += end - offset;
		if (this.wanted.length > MAX_ROUND_RANGES || this.wantedBytes > MAX_ROUND_BYTES) throw new PlanOverflow();
	}

	/** Reads the last run missed. */
	get missing(): number {
		return this.wanted.length;
	}
	/** The byte ranges the last run missed, as asked. */
	get missed(): readonly [number, number][] {
		return this.wanted;
	}

	/** Keep only the misses asked for before `cutoff` (a sequence number). */
	keepBefore(cutoff: number) {
		const keep = this.wantedOrder.map((seq, i) => (seq < cutoff ? i : -1)).filter((i) => i >= 0);
		this.wanted = keep.map((i) => this.wanted[i]);
		this.wantedOrder = keep.map((i) => this.wantedOrder[i]);
		this.wantedBytes = this.wanted.reduce((sum, [start, end]) => sum + end - start, 0);
	}
	/** Sequence numbers of this run's misses. */
	get missedOrder(): readonly number[] {
		return this.wantedOrder;
	}

	/** Put fetched bytes in, joining them to the pieces they overlap or touch. */
	insert(start: number, data: Uint8Array) {
		if (data.length === 0) return;
		let end = start + data.length;
		// Pieces from the first that reaches `start` to the last that begins by `end`.
		let first = this.pieceAt(start);
		if (first < 0 || this.starts[first] + this.pieces[first].length < start) first++;
		let last = first;
		while (last < this.starts.length && this.starts[last] <= end) last++;
		if (last > first) {
			const joinedStart = Math.min(start, this.starts[first]);
			const lastEnd = this.starts[last - 1] + this.pieces[last - 1].length;
			const joined = new Uint8Array(Math.max(end, lastEnd) - joinedStart);
			for (let i = first; i < last; i++) {
				joined.set(this.pieces[i], this.starts[i] - joinedStart);
				this.held -= this.pieces[i].length;
			}
			joined.set(data, start - joinedStart);
			start = joinedStart;
			data = joined;
			end = start + data.length;
		}
		this.starts.splice(first, last - first, start);
		this.pieces.splice(first, last - first, data);
		this.held += data.length;
	}

	/** Fetch everything the last run missed, in parallel. */
	async fetchWanted(): Promise<void> {
		const ahead = Math.min(AHEAD_MAX, Math.floor(AHEAD_BUDGET / this.wanted.length / GRAIN) * GRAIN);
		const ranges = this.wanted
			.map(([start, end]): [number, number] => [
				Math.floor(start / GRAIN) * GRAIN,
				Math.min(Math.ceil(end / GRAIN) * GRAIN + ahead, this.size)
			])
			.sort((a, b) => a[0] - b[0]);
		this.wanted = [];
		this.wantedOrder = [];
		this.wantedBytes = 0;
		const requests: [number, number][] = [];
		for (const [start, end] of ranges) {
			const last = requests[requests.length - 1];
			if (last && start <= last[1] + JOIN_GAP) last[1] = Math.max(last[1], end);
			else requests.push([start, end]);
		}
		if (this.held > MAX_HELD_BYTES) {
			this.starts = [];
			this.pieces = [];
			this.held = 0;
		}
		let next = 0;
		const worker = async () => {
			while (next < requests.length) {
				const [start, end] = requests[next++];
				const data = await this.fetchRange(start, end);
				this.requestCount++;
				this.bytesFetched += data.length;
				this.insert(start, data);
			}
		};
		await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, requests.length) }, worker));
	}

	/** Fetch the file's head and tail (all of a small file), which nearly every
	 * query reads first. */
	async seed(): Promise<void> {
		if (this.size <= 2 * SEED) this.want(0, this.size);
		else {
			this.want(0, SEED);
			this.want(this.size - SEED, this.size);
		}
		await this.fetchWanted();
	}

	/** Open a remote file. */
	static async open(url: string): Promise<SparseRangeReader> {
		// The size comes back with the first bytes, which are kept.
		// `no-store` throughout: the browser's HTTP cache locks a URL while it
		// writes to it, so parallel ranges of one file would wait on each other
		// (24 at once from S3: 10.9 s through the cache, 1.6 s without). The
		// fetched bytes are kept here instead.
		const res = await fetch(url, { headers: { Range: `bytes=0-${SEED - 1}` }, cache: 'no-store' });
		if (res.status !== 206) {
			throw new Error(`Range request not honoured (status ${res.status}); the host must support HTTP range requests.`);
		}
		const total = res.headers.get('Content-Range')?.split('/')[1];
		if (!total) throw new Error('Missing Content-Range header; cannot determine file size.');
		const reader = new SparseRangeReader(Number(total), async (start, end) => {
			const part = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: 'no-store' });
			if (part.status !== 206) throw new Error(`Range request failed with status ${part.status}`);
			return new Uint8Array(await part.arrayBuffer());
		});
		const data = new Uint8Array(await res.arrayBuffer());
		reader.requestCount = 1;
		reader.bytesFetched = data.length;
		reader.insert(0, data);
		await reader.seed();
		return reader;
	}
}

/** A WASI file whose bytes come from a SparseRangeReader. */
export class SparseFile extends WasiFile {
	constructor(public reader: SparseRangeReader) {
		super(new Uint8Array(0), { readonly: true });
	}
	get size(): bigint {
		return BigInt(this.reader.size);
	}
	stat() {
		return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, this.size);
	}
	path_open() {
		return { ret: wasi.ERRNO_SUCCESS, fd_obj: new SparseOpenFile(this) };
	}
}

export class SparseOpenFile extends OpenFile {
	declare file: SparseFile;
	fd_read(size: number) {
		const data = this.file.reader.readRange(Number(this.file_pos), size);
		this.file_pos += BigInt(data.length);
		return { ret: 0, data };
	}
	fd_pread(size: number, offset: bigint) {
		return { ret: 0, data: this.file.reader.readRange(Number(offset), size) };
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
	/** `posix_fadvise(WILLNEED)`: the program says which bytes it is about to
	 * read, so a long sequential read is fetched whole rather than found a
	 * buffer at a time. */
	advise(offset: bigint, length: bigint) {
		this.file.reader.want(Number(offset), Number(offset + length));
	}
}

export interface PlannedRun<T> {
	result: T;
	/** Rounds of fetching it took before a run missed nothing. */
	rounds: number;
}

/**
 * Run a query until it has read only real bytes. `run` is one attempt: it
 * must be repeatable, and may return or throw anything while bytes are missing.
 */
export async function runPlanned<T>(
	readers: SparseRangeReader[],
	run: () => T,
	maxRounds = 64,
	/** Called before each round's fetch, for tests and tracing. */
	onRound?: (round: number) => void
): Promise<PlannedRun<T>> {
	for (let rounds = 0; ; rounds++) {
		let result: T | undefined;
		let failure: unknown;
		for (const r of readers) r.oversize = 0;
		try {
			result = run();
		} catch (e) {
			failure = e;
			// A run gone astray on zeros, or a query too large: either way the
			// earliest misses are real, so fetch only those and go again. A
			// query too large then runs out of rounds.
			if (e instanceof PlanOverflow) {
				const order = readers.flatMap((r) => r.missedOrder).sort((a, b) => a - b);
				const cutoff = order[Math.min(AFTER_OVERFLOW, order.length) - 1] + 1;
				for (const r of readers) r.keepBefore(cutoff);
			}
		}
		if (readers.every((r) => r.missing === 0)) {
			if (readers.some((r) => r.oversize > 0)) {
				throw new Error('That region reads too much of the index at once. Try a narrower one.');
			}
			if (failure !== undefined) throw failure;
			return { result: result as T, rounds };
		}
		if (rounds >= maxRounds) throw new Error(`The query did not settle in ${maxRounds} rounds of fetching.`);
		onRound?.(rounds);
		await Promise.all(readers.map((r) => r.fetchWanted()));
	}
}
