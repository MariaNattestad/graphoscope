// Background context escalation for a locus query.
//
// The reducer trims every query to the locus (crates/reduce/src/locus.rs): the
// reference shown is the locus, and context only extends into alt alleles
// reached from it. So context no longer pads what is shown — it only decides how
// far an allele leaving the locus is followed before GBZ-base stops fetching.
// The reducer reports what was cut off as `exitEdges` (edges from the locus
// component to nodes that were not fetched).
//
// That makes context something to *search* rather than pick: paint first with a
// small context (fast), then re-query at growing contexts in a background worker,
// stopping as soon as nothing leaves the locus unresolved or a budget is hit.
// When a step resolves something, the page offers it (a pill) instead of swapping
// the graph under the user. The manual context control remains an override.

import type { GbzClient, LocusQuery, QueryResult, QuerySource } from './gbzClient';
import { reducedStatsOf, type ReducedStats } from './gfa';
import { MAX_GFA_BYTES } from './graphs';

/** Context for the first paint when the user hasn't chosen one. */
export const FIRST_PAINT_CONTEXT = 1000;
/** Contexts tried in the background, in order, after the first paint. */
export const ESCALATION_CONTEXTS = [10_000, 50_000, 100_000];

export interface EscalationBudget {
	/** Range-request bytes, summed over the escalation steps (not the first paint). */
	maxBytesFetched: number;
	/** Nodes GBZ-base fetched in one step (`FN`) — the cost driver for the wasm. */
	maxFetchedNodes: number;
	/** wasm linear memory after one step. */
	maxWasmMemoryBytes: number;
	/** The reduced GFA itself, which the page refuses past this size anyway. */
	maxGfaBytes: number;
	/** Nodes in the reduced graph. Past this a result is not offered (and the
	 * ladder stops): resolving every exit is not worth a graph too big to lay
	 * out comfortably — LPA's KIV-2 expansions resolve at 50 kb into ~18k nodes. */
	maxNodesShown: number;
}

export const DEFAULT_BUDGET: EscalationBudget = {
	maxBytesFetched: 128 * 1024 * 1024,
	maxFetchedNodes: 250_000,
	maxWasmMemoryBytes: 1024 * 1024 * 1024,
	maxGfaBytes: MAX_GFA_BYTES,
	maxNodesShown: 5_000
};

/** One background query's outcome — what the page logs and the pill reports. */
export interface EscalationStep {
	context: number;
	ok: boolean;
	error?: string;
	exits: number;
	rejoins: number;
	extLeftBp: number;
	extRightBp: number;
	fetchedNodes: number;
	nodesShown: number;
	bytesFetched: number;
	requestCount: number;
	elapsedMs: number;
	wasmMemoryBytes: number;
	gfaBytes: number;
}

export function stepOf(context: number, r: QueryResult): EscalationStep {
	const stats = r.ok && r.gfa ? reducedStatsOf(r.gfa) : undefined;
	const l = stats?.locus;
	return {
		context,
		ok: r.ok && !!stats,
		error: r.ok ? (stats ? undefined : 'no stats line') : r.error,
		exits: l?.exitEdges ?? 0,
		rejoins: l?.rejoins ?? 0,
		extLeftBp: l?.extLeftBp ?? 0,
		extRightBp: l?.extRightBp ?? 0,
		fetchedNodes: l?.fetchedNodes ?? stats?.segmentsBefore ?? 0,
		nodesShown: stats?.segmentsAfter ?? 0,
		bytesFetched: r.stats?.bytesFetched ?? 0,
		requestCount: r.stats?.requestCount ?? 0,
		elapsedMs: r.stats?.elapsedMs ?? 0,
		wasmMemoryBytes: r.stats?.wasmMemoryBytes ?? 0,
		gfaBytes: r.gfa?.length ?? 0
	};
}

/** Exits the shown graph leaves unresolved, or 0 for an untrimmed graph. */
export function unresolvedExits(stats: ReducedStats | undefined): number {
	return stats?.locus?.exitEdges ?? 0;
}

/** Why escalation should stop after `steps`, or null to keep going. */
export function stopReason(
	steps: EscalationStep[],
	budget: EscalationBudget = DEFAULT_BUDGET
): 'resolved' | 'error' | 'budget' | 'ladder' | null {
	const last = steps[steps.length - 1];
	if (!last) return null;
	if (!last.ok) return 'error';
	if (last.nodesShown > budget.maxNodesShown || last.gfaBytes > budget.maxGfaBytes) return 'budget';
	if (last.exits === 0) return 'resolved';
	const bytes = steps.reduce((s, x) => s + x.bytesFetched, 0);
	if (
		bytes > budget.maxBytesFetched ||
		last.fetchedNodes > budget.maxFetchedNodes ||
		last.wasmMemoryBytes > budget.maxWasmMemoryBytes ||
		last.gfaBytes > budget.maxGfaBytes ||
		last.nodesShown > budget.maxNodesShown
	)
		return 'budget';
	if (!ESCALATION_CONTEXTS.some((c) => c > last.context)) return 'ladder';
	return null;
}

/** Whether a step's result is worth offering over what is shown: it resolves
 * at least one exit, and is not itself over the size the page will render. */
export function isImprovement(
	step: EscalationStep,
	shownExits: number,
	budget: EscalationBudget = DEFAULT_BUDGET
): boolean {
	return (
		step.ok &&
		step.exits < shownExits &&
		step.gfaBytes <= budget.maxGfaBytes &&
		step.nodesShown <= budget.maxNodesShown
	);
}

export interface EscalationOffer {
	context: number;
	gfaText: string;
	stats: QueryResult['stats'];
	step: EscalationStep;
	/** Exits on screen now, and how many this result resolves. */
	shownExits: number;
	resolved: number;
}

/**
 * Runs the ladder for one locus on its own worker (so it never queues behind, or
 * blocks, a query the user starts), reporting each step and every improvement.
 * A new `start` or `cancel` abandons the run in flight — terminating its worker
 * if a query is mid-way, since the wasm runs synchronously and can't be told.
 */
export class Escalator {
	private client: GbzClient | null = null;
	private runId = 0;
	private busy = false;

	constructor(private makeClient: () => GbzClient) {}

	cancel() {
		this.runId++;
		if (this.busy && this.client) {
			this.client.terminate();
			this.client = null;
		}
		this.busy = false;
	}

	async start(
		source: QuerySource,
		locus: LocusQuery,
		fromContext: number,
		shownExits: number,
		cb: {
			onStep?: (step: EscalationStep) => void;
			/** Every raw result, for logging/measurement. */
			onResult?: (result: QueryResult, context: number) => void;
			onOffer: (offer: EscalationOffer) => void;
			onDone?: (reason: string, steps: EscalationStep[]) => void;
		},
		budget: EscalationBudget = DEFAULT_BUDGET
	): Promise<void> {
		this.cancel();
		const run = this.runId;
		const steps: EscalationStep[] = [];
		let best = shownExits;
		for (const context of ESCALATION_CONTEXTS) {
			if (context <= fromContext) continue;
			if (!this.client) this.client = this.makeClient();
			this.busy = true;
			let r: QueryResult;
			try {
				r = await this.client.query(source, { ...locus, context });
			} finally {
				if (run === this.runId) this.busy = false;
			}
			if (run !== this.runId) return; // superseded
			cb.onResult?.(r, context);
			const step = stepOf(context, r);
			steps.push(step);
			cb.onStep?.(step);
			if (isImprovement(step, best, budget) && r.gfa) {
				cb.onOffer({
					context,
					gfaText: r.gfa,
					stats: r.stats,
					step,
					shownExits,
					resolved: shownExits - step.exits
				});
				best = step.exits;
			}
			const reason = stopReason(steps, budget);
			if (reason) {
				cb.onDone?.(reason, steps);
				return;
			}
		}
		cb.onDone?.('ladder', steps);
	}

	terminate() {
		this.cancel();
		this.client?.terminate();
		this.client = null;
	}
}
