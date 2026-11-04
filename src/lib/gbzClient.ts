// Main-thread client for the query worker. Turns the worker's message protocol
// into a promise-based API and builds query arguments from a locus request.

import type { QueryRequest, QueryResult, QuerySource } from './query.worker';
import { base } from '$app/paths';

export type { QuerySource, QueryResult };

// Computed on the main thread (safe here — `$app/paths` needs `window`, which
// only exists outside the worker) and sent with every request instead of
// re-derived inside the worker. See the long comment on QueryRequest.wasmUrl
// for why deriving this inside the worker is unsafe.
const WASM_URL = `${base}/query.wasm`;

/** Subgraph context margin (bp) for a single-shot query with no `context`
 * param — the /api endpoint's default. (The wasm's own fallback, in
 * crates/reduce, is 100.) The interactive page instead paints at
 * FIRST_PAINT_CONTEXT and escalates in the background (see escalation.ts).
 *
 * Since the reducer trims to the locus, context no longer pads the reference
 * axis: it only bounds how far an allele leaving the locus is followed. */
export const DEFAULT_CONTEXT = 10000;

export interface LocusQuery {
	sample: string; // e.g. "GRCh38"
	contig: string; // e.g. "chr6"
	start: number; // 0-based
	end: number; // half-open
	/** Longest-path bp threshold for collapsing a small variant. */
	maxVariant?: number;
	/** Subgraph context radius in bp: how far past the locus GBZ-base follows the
	 * graph before cutting haplotypes off (the app default is DEFAULT_CONTEXT). Larger shows
	 * more of where the haplotypes go, at the cost of a bigger subgraph. */
	context?: number;
	/** Ask for the unsimplified subgraph (every haplotype walk) instead of the
	 * reduced GFA. Only for the download button — this is the response the app
	 * deliberately never parses. */
	raw?: boolean;
	/** Keep GBZ-base's whole context-padded subgraph instead of trimming it to
	 * the locus (crates/reduce/src/locus.rs). A comparison/debug switch. */
	noTrim?: boolean;
}

export class GbzClient {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, (r: QueryResult) => void>();

	constructor() {
		this.worker = new Worker(new URL('./query.worker.ts', import.meta.url), { type: 'module' });
		this.worker.onmessage = (ev: MessageEvent<QueryResult>) => {
			const cb = this.pending.get(ev.data.id);
			if (cb) {
				this.pending.delete(ev.data.id);
				cb(ev.data);
			}
		};
	}

	private send(source: QuerySource, args: string[]): Promise<QueryResult> {
		const id = this.nextId++;
		const req: QueryRequest = { id, source, args, wasmUrl: WASM_URL };
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.worker.postMessage(req);
		});
	}

	/**
	 * Extract the subgraph for a locus. The wasm binary (crates/reduce) always
	 * returns the reduced GFA — simplified, with haplotype walks aggregated into
	 * per-node/edge counts — so there's no output-format choice to make here.
	 */
	query(source: QuerySource, locus: LocusQuery): Promise<QueryResult> {
		const args = [
			'--sample',
			locus.sample,
			'--contig',
			locus.contig,
			'--interval',
			`${locus.start}..${locus.end}`
		];
		if (locus.context != null) args.push('--context', String(locus.context));
		if (locus.noTrim) args.push('--no-trim');
		if (locus.raw) args.push('--raw');
		else if (locus.maxVariant != null) args.push('--max-variant', String(locus.maxVariant));
		return this.send(source, args);
	}

	/** Stops the worker. Queries still pending resolve as failed, so nothing
	 * awaiting them hangs. */
	terminate() {
		this.worker.terminate();
		for (const [id, cb] of this.pending) cb({ id, ok: false, error: 'terminated' });
		this.pending.clear();
	}
}

/** Parse "chr6:31,972,046-32,055,647" (or with a sample prefix) into a LocusQuery. */
export function parseLocus(input: string, defaultSample = 'GRCh38'): LocusQuery {
	let sample = defaultSample;
	let rest = input.trim();
	// Optional "SAMPLE#..#contig:.." or "SAMPLE contig:.." prefix.
	const hashParts = rest.split('#');
	if (hashParts.length === 3) {
		sample = hashParts[0];
		rest = hashParts[2];
	}
	const m = rest.match(/^([\w.]+):([\d,]+)\s*-\s*([\d,]+)$/);
	if (!m) {
		throw new Error(`Could not parse locus "${input}". Expected e.g. chr6:31972046-32055647`);
	}
	const contig = m[1];
	const start = Number(m[2].replace(/,/g, ''));
	const end = Number(m[3].replace(/,/g, ''));
	if (!(end > start)) throw new Error('End coordinate must be greater than start.');
	return { sample, contig, start, end };
}
