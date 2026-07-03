// Main-thread client for the query worker. Turns the worker's message protocol
// into a promise-based API and builds query arguments from a locus request.

import type { QueryRequest, QueryResult, QuerySource } from './query.worker';

export type { QuerySource, QueryResult };

export interface LocusQuery {
	sample: string; // e.g. "GRCh38"
	contig: string; // e.g. "chr6"
	start: number; // 0-based
	end: number; // half-open
	/** Haplotype output mode. */
	haplotypes?: 'all' | 'distinct' | 'reference-only';
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
		const req: QueryRequest = { id, source, args };
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.worker.postMessage(req);
		});
	}

	/** Extract the subgraph for a locus as GFA text. Uses an interval query. */
	query(source: QuerySource, locus: LocusQuery): Promise<QueryResult> {
		const args = [
			'--sample',
			locus.sample,
			'--contig',
			locus.contig,
			'--interval',
			`${locus.start}..${locus.end}`
		];
		if (locus.haplotypes === 'distinct') args.push('--distinct');
		else if (locus.haplotypes === 'reference-only') args.push('--reference-only');
		return this.send(source, args);
	}

	terminate() {
		this.worker.terminate();
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
