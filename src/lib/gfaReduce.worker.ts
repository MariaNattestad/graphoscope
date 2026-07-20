/// <reference lib="webworker" />
// Web Worker that runs the real `query.wasm` over a GFA held in memory, using
// its `--gfa` mode. This is what /playground uses, so the simplification you see
// demonstrated there is the same code path — the same binary — that runs against
// a live locus, rather than a parallel implementation that can drift from it.

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

export interface ReduceRequest {
	id: number;
	gfaText: string;
	maxVariant?: number;
	/** See QueryRequest.wasmUrl in query.worker.ts for why this is passed in. */
	wasmUrl: string;
}

export interface ReduceResult {
	id: number;
	ok: boolean;
	gfa?: string;
	stderr?: string;
	error?: string;
	elapsedMs?: number;
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
		for (const c of this.chunks) total += c.byteLength;
		const buf = new Uint8Array(total);
		let at = 0;
		for (const c of this.chunks) {
			buf.set(c, at);
			at += c.byteLength;
		}
		return new TextDecoder().decode(buf);
	}
}

let modulePromise: Promise<WebAssembly.Module> | null = null;
function getModule(url: string): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = WebAssembly.compileStreaming(fetch(url)).catch(async () => {
			const bytes = await (await fetch(url)).arrayBuffer();
			return WebAssembly.compile(bytes);
		});
	}
	return modulePromise;
}

async function reduce(req: ReduceRequest): Promise<ReduceResult> {
	const t0 = performance.now();
	const stdout = new CollectorFd();
	const stderr = new CollectorFd();
	const input = new WasiFile(new TextEncoder().encode(req.gfaText));
	const fds: Fd[] = [
		new OpenFile(new WasiFile(new Uint8Array(0))), // 0: stdin
		stdout, // 1
		stderr, // 2
		new PreopenDirectory('/data', new Map<string, Inode>([['input.gfa', input]])) // 3
	];

	const args = ['query', '--gfa', '/data/input.gfa'];
	if (req.maxVariant != null) args.push('--max-variant', String(req.maxVariant));

	const wasiInstance = new WASI(args, [], fds, { debug: false });
	const module = await getModule(req.wasmUrl);
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

	const elapsedMs = Math.round(performance.now() - t0);
	if (exitCode !== 0) {
		return {
			id: req.id,
			ok: false,
			error: `reduce exited with code ${exitCode}`,
			stderr: stderr.text(),
			elapsedMs
		};
	}
	return { id: req.id, ok: true, gfa: stdout.text(), stderr: stderr.text(), elapsedMs };
}

self.onmessage = async (ev: MessageEvent<ReduceRequest>) => {
	const req = ev.data;
	try {
		(self as DedicatedWorkerGlobalScope).postMessage(await reduce(req));
	} catch (e) {
		(self as DedicatedWorkerGlobalScope).postMessage({
			id: req.id,
			ok: false,
			error: e instanceof Error ? e.message : String(e)
		} satisfies ReduceResult);
	}
};
