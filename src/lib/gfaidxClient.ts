// Main-thread side of the /gfaidx page's two workers: the gfaidx query
// (gfaidx.worker.ts, range requests against the index) and Graphoscope's own
// Simplify run over the result (gfaReduce.worker.ts, query.wasm's --gfa mode).

import { base } from '$app/paths';
import type { GfaidxRequest, GfaidxResult } from './gfaidx.worker';
import type { ReduceRequest, ReduceResult } from './gfaReduce.worker';

export class GfaidxClient {
	private query: Worker;
	private reducer: Worker;
	private nextId = 1;
	private pending = new Map<number, (result: GfaidxResult | ReduceResult) => void>();

	constructor() {
		this.query = new Worker(new URL('./gfaidx.worker.ts', import.meta.url), { type: 'module' });
		this.reducer = new Worker(new URL('./gfaReduce.worker.ts', import.meta.url), { type: 'module' });
		const settle = (ev: MessageEvent<GfaidxResult | ReduceResult>) => {
			const resolve = this.pending.get(ev.data.id);
			this.pending.delete(ev.data.id);
			resolve?.(ev.data);
		};
		this.query.onmessage = settle;
		this.reducer.onmessage = settle;
	}

	/** Run one gfaidx command against the index at `indexUrl`. */
	run(indexUrl: string, command: string, args: string[] = []): Promise<GfaidxResult> {
		const id = this.nextId++;
		const req: GfaidxRequest = { id, indexUrl, command, args, wasmUrl: `${base}/gfaidx.wasm` };
		return new Promise((resolve) => {
			this.pending.set(id, resolve as (r: GfaidxResult | ReduceResult) => void);
			this.query.postMessage(req);
		});
	}

	/** Simplify a GFA whose walks are `W` lines: variants under `maxVariant` bp
	 * are popped and the walks folded into coverage, as on the locus browser. */
	reduce(gfaText: string, maxVariant: number): Promise<ReduceResult> {
		const id = this.nextId++;
		const req: ReduceRequest = { id, gfaText, maxVariant, wasmUrl: `${base}/query.wasm` };
		return new Promise((resolve) => {
			this.pending.set(id, resolve as (r: GfaidxResult | ReduceResult) => void);
			this.reducer.postMessage(req);
		});
	}

	terminate() {
		this.query.terminate();
		this.reducer.terminate();
	}
}
