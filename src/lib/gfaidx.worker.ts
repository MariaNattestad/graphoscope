/// <reference lib="webworker" />
// Web Worker that runs `gfaidx.wasm` (the gfaidx query library, built by
// scripts/build-gfaidx-wasm.sh) against a gfaidx index sitting on a static host.
//
// A gfaidx index is several files side by side: the graph itself, recompressed
// so each community of nodes is its own gzip member, and sidecars that say where
// things are. Each is mounted as a file read by HTTP range request, so a query
// fetches the few kilobytes it touches and never the whole index. There is no
// server.
//
// A region query makes hundreds of small reads scattered over the index (a few
// per haplotype), so they are not fetched one at a time as the GBZ query's are:
// the query is run as a plan, the reads it names are fetched in parallel, and
// it is run again until it has seen only real bytes (see sparseVfs.ts).

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
import { SparseRangeReader, SparseFile, SparseOpenFile, PlanOverflow, runPlanned } from './sparseVfs';
import { INDEX_SIDECARS } from './gfaidx';

export interface GfaidxRequest {
	id: number;
	/** URL of the indexed graph (`….gfa.gz`). Its sidecars are beside it, named
	 * by appending `.idx`, `.ndx`, `.pdx`, `.lnx`, `.pcx` and (rGFA only) `.cdx`. */
	indexUrl: string;
	/** `tracks`, `region` or `subgraph`: see crates/gfaidx-wasm/src/main.cpp. */
	command: string;
	/** The command's flags, e.g. ['--sequence', 'CHM13#0#chr21', '--begin', '1', '--end', '9']. */
	args: string[];
	/** Root-relative or absolute URL of gfaidx.wasm, computed on the main thread
	 * (see QueryRequest.wasmUrl in query.worker.ts for why). */
	wasmUrl: string;
}

export interface GfaidxResult {
	id: number;
	ok: boolean;
	/** What the command wrote: GFA, or the tracks table. */
	out?: string;
	stderr?: string;
	error?: string;
	stats?: {
		requestCount: number;
		bytesFetched: number;
		diskHits: number;
		/** Bytes of the whole index (graph and sidecars), for scale. */
		indexSize: number;
		/** Rounds of parallel fetching before the query had every byte it reads. */
		rounds: number;
		elapsedMs: number;
	};
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

let modulePromise: Promise<WebAssembly.Module> | null = null;
function getModule(wasmUrl: string): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = WebAssembly.compileStreaming(fetch(wasmUrl))
			.catch(async () => {
				const bytes = await (await fetch(wasmUrl)).arrayBuffer();
				return WebAssembly.compile(bytes);
			})
			.catch((e) => {
				modulePromise = null;
				// gfaidx is C++ that throws, built with WebAssembly's standard exception
				// handling, which browsers from before 2025 don't have.
				throw new Error(
					`This browser could not load gfaidx.wasm (${e instanceof Error ? e.message : String(e)}). ` +
						'It uses WebAssembly exception handling, which needs a recent browser.'
				);
			});
	}
	return modulePromise;
}

interface OpenIndex {
	/** Sidecar suffix ('' for the graph) → its reader. Optional sidecars that
	 * aren't on the host are simply absent. */
	readers: Map<string, SparseRangeReader>;
}

// One open index at a time, kept (with its warm block caches) across queries.
let cached: { url: string; index: Promise<OpenIndex> } | null = null;
function openIndex(url: string): Promise<OpenIndex> {
	if (cached && cached.url === url) return cached.index;
	const index = (async (): Promise<OpenIndex> => {
		const open = async ({ suffix, required }: (typeof INDEX_SIDECARS)[number]) => {
			try {
				return [suffix, await SparseRangeReader.open(url + suffix)] as const;
			} catch (e) {
				if (!required) return null;
				throw new Error(
					`Could not open ${url + suffix}: ${e instanceof Error ? e.message : String(e)}. ` +
						'A gfaidx index needs the graph and its .idx and .ndx beside it, on a host that allows CORS and range requests. ' +
						'(A host that serves a .gz file with Content-Encoding: gzip breaks range requests on it: give the graph another extension.)'
				);
			}
		};
		const readers = new Map<string, SparseRangeReader>();
		const opened = await Promise.all(INDEX_SIDECARS.filter((s) => !s.insteadOf).map(open));
		for (const entry of opened) if (entry) readers.set(entry[0], entry[1]);
		// A sidecar that stands in for another is only asked for when that one is absent.
		for (const sidecar of INDEX_SIDECARS) {
			if (!sidecar.insteadOf || readers.has(sidecar.insteadOf)) continue;
			const entry = await open(sidecar);
			if (entry) readers.set(entry[0], entry[1]);
		}
		return { readers };
	})();
	cached = { url, index };
	index.catch(() => {
		if (cached?.index === index) cached = null; // let a retry reopen
	});
	return index;
}

const baseline = new WeakMap<SparseRangeReader, { requests: number; bytes: number }>();

interface Attempt {
	exitCode: number;
	out: string;
	err: string;
}

/** One run of the query over whatever bytes have been fetched so far. */
function attempt(module: WebAssembly.Module, index: OpenIndex, req: GfaidxRequest): Attempt {
	const stdout = new CollectorFd();
	const stderr = new CollectorFd();
	const files = new Map<string, Inode>();
	for (const [suffix, reader] of index.readers) files.set(`graph.gfa.gz${suffix}`, new SparseFile(reader));
	const fds: Fd[] = [
		new OpenFile(new WasiFile(new Uint8Array(0))), // 0: stdin
		stdout, // 1
		stderr, // 2
		new PreopenDirectory('/data', files) // 3: preopen
	];
	const wasiInstance = new WASI(['gfaidx-query', req.command, '/data/graph.gfa.gz', ...req.args], [], fds, {
		debug: false
	});
	// The shim accepts fd_advise and drops it. gfaidx (as patched) uses it to say
	// which bytes of the graph it is about to read through.
	const imports = {
		...wasiInstance.wasiImport,
		fd_advise(fd: number, offset: bigint, length: bigint) {
			const open = wasiInstance.fds[fd];
			if (open instanceof SparseOpenFile) open.advise(offset, length);
			return open ? wasi.ERRNO_SUCCESS : wasi.ERRNO_BADF;
		}
	};
	const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports });
	let exitCode = 0;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		exitCode = wasiInstance.start(instance as any);
	} catch (e) {
		if (e instanceof WASIProcExit) exitCode = e.code;
		else if (e instanceof PlanOverflow) throw e;
		// A run on bytes not fetched yet (zeros) may trap instead of exiting.
		// With every byte real, a trap is a failure like any other.
		else return { exitCode: -1, out: '', err: e instanceof Error ? e.message : String(e) };
	}
	return { exitCode, out: stdout.text(), err: stderr.text() };
}

async function run(req: GfaidxRequest): Promise<GfaidxResult> {
	const t0 = performance.now();
	const [index, module] = await Promise.all([openIndex(req.indexUrl), getModule(req.wasmUrl)]);
	const readers = [...index.readers.values()];
	const before = readers.map((r) => baseline.get(r) ?? { requests: 0, bytes: 0 });

	// A context search follows the graph node by node, each step a look-up that
	// depends on the last: far more rounds than the handful a span query takes.
	const { result, rounds } = await runPlanned(readers, () => attempt(module, index, req), 400);

	let requestCount = 0;
	let bytesFetched = 0;
	let indexSize = 0;
	readers.forEach((r, i) => {
		requestCount += r.requestCount - before[i].requests;
		bytesFetched += r.bytesFetched - before[i].bytes;
		indexSize += r.size;
		baseline.set(r, { requests: r.requestCount, bytes: r.bytesFetched });
	});
	const stats = {
		requestCount,
		bytesFetched,
		diskHits: 0,
		indexSize,
		rounds,
		elapsedMs: Math.round(performance.now() - t0)
	};

	if (result.exitCode !== 0) {
		// gfaidx reports a failure as its last stderr line: "gfaidx error: …".
		const reason = /gfaidx error: (.*)\s*$/.exec(result.err)?.[1];
		return {
			id: req.id,
			ok: false,
			error: reason ?? (result.exitCode < 0 ? `gfaidx stopped: ${result.err}` : `gfaidx exited with code ${result.exitCode}`),
			stderr: result.err,
			stats
		};
	}
	return { id: req.id, ok: true, out: result.out, stderr: result.err, stats };
}

self.onmessage = async (ev: MessageEvent<GfaidxRequest>) => {
	const req = ev.data;
	try {
		(self as DedicatedWorkerGlobalScope).postMessage(await run(req));
	} catch (e) {
		(self as DedicatedWorkerGlobalScope).postMessage({
			id: req.id,
			ok: false,
			error: e instanceof Error ? e.message : String(e)
		} satisfies GfaidxResult);
	}
};
