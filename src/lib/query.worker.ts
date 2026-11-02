/// <reference lib="webworker" />
// Web Worker that runs `query.wasm` against a GBZ-base DB, reading it lazily via
// range requests. Kept on a worker thread because the VFS uses synchronous XHR /
// FileReaderSync, which would block (or is unavailable on) the main thread.

import {
	WASI,
	WASIProcExit,
	Fd,
	File as WasiFile,
	OpenFile,
	PreopenDirectory,
	Inode,
	wasi
} from '@bjorn3/browser_wasi_shim';
import { HttpRangeReader, BlobRangeReader, LazyFile, type RangeReader } from './vfs';
import { warmGbzDb } from './sqliteWarm';

export type QuerySource = { kind: 'url'; url: string } | { kind: 'file'; file: File };

export interface QueryRequest {
	id: number;
	source: QuerySource;
	args: string[]; // query flags, e.g. ['--sample','GRCh38','--contig','chr6','--offset','31972046','--context','20k']
	/**
	 * Absolute (or root-relative, i.e. leading "/") URL for `query.wasm`,
	 * computed on the main thread. Deliberately NOT derived in here from
	 * `$app/paths` or `import.meta.env.BASE_URL`: the former touches `window`
	 * (absent in a Worker, throws immediately on import) and the latter can be
	 * emitted as a *relative* path ("./"), which — unlike a root-relative path
	 * — resolves against the worker script's own location, not the page/site
	 * root, silently fetching the wrong URL under a subpath deployment like
	 * GitHub Pages. A leading-slash (or fully absolute) URL sidesteps both.
	 */
	wasmUrl: string;
}

export interface QueryResult {
	id: number;
	ok: boolean;
	gfa?: string;
	stderr?: string;
	error?: string;
	stats?: { requestCount: number; bytesFetched: number; dbSize: number; elapsedMs: number };
}

/** Accumulates bytes written to a WASI fd (used for stdout / stderr). */
class CollectorFd extends Fd {
	chunks: Uint8Array[] = [];
	fd_write(data: Uint8Array) {
		this.chunks.push(data.slice());
		return { ret: 0, nwritten: data.byteLength };
	}
	fd_fdstat_get() {
		const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
		fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
		return { ret: 0, fdstat };
	}
	fd_filestat_get() {
		return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
	}
	text(): string {
		let total = 0;
		for (const c of this.chunks) total += c.length;
		const buf = new Uint8Array(total);
		let off = 0;
		for (const c of this.chunks) {
			buf.set(c, off);
			off += c.length;
		}
		return new TextDecoder().decode(buf);
	}
}

// Compile the wasm module once; instantiate a fresh instance per query.
let modulePromise: Promise<WebAssembly.Module> | null = null;
function getModule(wasmUrl: string): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = WebAssembly.compileStreaming(fetch(wasmUrl));
	}
	return modulePromise;
}

// Reuse a reader (and its warm block cache) when querying the same source again.
// Cached as a promise so a second query arriving mid-open shares the first's.
let cachedReader: { key: string; reader: Promise<RangeReader> } | null = null;
function getReader(source: QuerySource): Promise<RangeReader> {
	const key = source.kind === 'url' ? `url:${source.url}` : `file:${source.file.name}:${source.file.size}`;
	if (cachedReader && cachedReader.key === key) return cachedReader.reader;
	const reader = (async (): Promise<RangeReader> => {
		const r = source.kind === 'url' ? await HttpRangeReader.open(source.url) : new BlobRangeReader(source.file);
		// Remote only: a local file has no round trips to save.
		if (source.kind === 'url') await warmGbzDb(r).catch(() => {});
		return r;
	})();
	cachedReader = { key, reader };
	reader.catch(() => {
		if (cachedReader?.reader === reader) cachedReader = null; // let a retry reopen
	});
	return reader;
}

// Per-reader request/byte totals as of the end of its last query, so each
// query's stats count only its own fetches (plus, for the first, the open).
const cachedStatsBaseline = new WeakMap<RangeReader, { requests: number; bytes: number }>();

async function runQuery(req: QueryRequest): Promise<QueryResult> {
	const t0 = performance.now();
	// Opening (and warming) the DB and compiling the wasm are independent: overlap them.
	const [reader, module] = await Promise.all([getReader(req.source), getModule(req.wasmUrl)]);
	// A first query's stats include the open + warm-up requests, so its counts and
	// time reflect everything the user actually waited for.
	const before = cachedStatsBaseline.get(reader) ?? { requests: 0, bytes: 0 };

	const stdout = new CollectorFd();
	const stderr = new CollectorFd();
	const dbFile = new LazyFile(reader);
	const fds: Fd[] = [
		new OpenFile(new WasiFile(new Uint8Array(0))), // 0: stdin
		stdout, // 1
		stderr, // 2
		new PreopenDirectory('/data', new Map<string, Inode>([['graph.db', dbFile]])) // 3: preopen
	];

	const args = ['query', ...req.args, '/data/graph.db'];
	const wasiInstance = new WASI(args, [], fds, { debug: false });

	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: wasiInstance.wasiImport
	});

	let exitCode = 0;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		exitCode = wasiInstance.start(instance as any);
	} catch (e) {
		if (e instanceof WASIProcExit) exitCode = e.code;
		else throw e;
	}

	cachedStatsBaseline.set(reader, { requests: reader.requestCount, bytes: reader.bytesFetched });
	const stats = {
		requestCount: reader.requestCount - before.requests,
		bytesFetched: reader.bytesFetched - before.bytes,
		dbSize: reader.size,
		elapsedMs: Math.round(performance.now() - t0)
	};

	if (exitCode !== 0) {
		return { id: req.id, ok: false, error: `query exited with code ${exitCode}`, stderr: stderr.text(), stats };
	}
	return { id: req.id, ok: true, gfa: stdout.text(), stderr: stderr.text(), stats };
}

self.onmessage = async (ev: MessageEvent<QueryRequest>) => {
	const req = ev.data;
	try {
		const result = await runQuery(req);
		(self as DedicatedWorkerGlobalScope).postMessage(result);
	} catch (e) {
		(self as DedicatedWorkerGlobalScope).postMessage({
			id: req.id,
			ok: false,
			error: e instanceof Error ? e.message : String(e)
		} satisfies QueryResult);
	}
};
