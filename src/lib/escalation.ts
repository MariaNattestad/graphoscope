// Background context escalation for a locus query.
//
// The reducer trims every query to the locus (crates/reduce/src/locus.rs): the
// reference shown is the locus (extended to where alleles leaving or spanning it
// rejoin), and context only extends into alt alleles reached from it. So context no longer pads what is shown — it only decides how
// far an allele leaving the locus is followed before GBZ-base stops fetching.
// The reducer reports what was cut off as `exitEdges` (edges from the locus
// component to nodes that were not fetched) plus `openEnds` (possible
// connections spanning the locus whose far end wasn't fetched); together, the
// open ends the ladder tries to resolve.
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
	missing: number;
	spans: number;
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
		exits: openEnds(stats),
		missing: missingHaplotypes(stats),
		spans: l?.spans ?? 0,
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

/** Open ends the graph leaves unresolved — exit edges plus possible spans
 * whose far end isn't fetched — or 0 for an untrimmed graph. */
export function openEnds(stats: ReducedStats | undefined): number {
	return (stats?.locus?.exitEdges ?? 0) + (stats?.locus?.openEnds ?? 0);
}
export const unresolvedExits = openEnds;

/**
 * Haplotypes in the graph that never reach the kept graph — they go around the
 * locus. A deletion of the whole locus whose two ends both lie beyond a small
 * context leaves no node or edge in the fetched subgraph, so this deficit is the
 * only sign of it at first paint. It also counts haplotypes simply absent here
 * (assembly gaps, one-copy chrX in males), which no context resolves — so the
 * ladder chases it only while it keeps shrinking. 0 when the graph's haplotype
 * count is unknown.
 */
export function missingHaplotypes(stats: ReducedStats | undefined): number {
	const ht = stats?.locus?.graphHaplotypes ?? 0;
	return ht > 0 && stats ? Math.max(0, ht - stats.totalWalks) : 0;
}
/** Below this many missing haplotypes the deficit isn't worth a query. */
export const MISSING_MIN = 2;

/** What's left unresolved in a view: open ends, and haplotypes going around it. */
export interface Unresolved {
	exits: number;
	missing: number;
}
export function unresolvedOf(stats: ReducedStats | undefined): Unresolved {
	return { exits: openEnds(stats), missing: missingHaplotypes(stats) };
}
/** Whether a view is worth escalating from at all. */
export function worthEscalating(u: Unresolved): boolean {
	return u.exits > 0 || u.missing >= MISSING_MIN;
}

/**
 * Which budget the latest step broke, or null. The byte budget is cumulative
 * over the run; the others are per step. A step over budget is never offered:
 * the view stays on the last result that fit (the first paint, or an earlier
 * step already offered/applied).
 */
export function overBudget(
	steps: EscalationStep[],
	budget: EscalationBudget = DEFAULT_BUDGET
): 'bytes' | 'fetched nodes' | 'memory' | 'size' | 'nodes' | null {
	const last = steps[steps.length - 1];
	if (!last) return null;
	if (last.nodesShown > budget.maxNodesShown) return 'nodes';
	if (last.gfaBytes > budget.maxGfaBytes) return 'size';
	if (last.wasmMemoryBytes > budget.maxWasmMemoryBytes) return 'memory';
	if (last.fetchedNodes > budget.maxFetchedNodes) return 'fetched nodes';
	if (steps.reduce((s, x) => s + x.bytesFetched, 0) > budget.maxBytesFetched) return 'bytes';
	return null;
}

/** Why escalation should stop after `steps`, or null to keep going. */
export function stopReason(
	steps: EscalationStep[],
	budget: EscalationBudget = DEFAULT_BUDGET,
	start: Unresolved = { exits: 0, missing: 0 }
): 'resolved' | 'error' | 'budget' | 'ladder' | null {
	const last = steps[steps.length - 1];
	if (!last) return null;
	if (!last.ok) return 'error';
	if (overBudget(steps, budget)) return 'budget';
	// Keep chasing missing haplotypes only while a step still finds some.
	const prevMissing = steps.length > 1 ? steps[steps.length - 2].missing : start.missing;
	const chasing = last.missing >= MISSING_MIN && last.missing < prevMissing;
	if (last.exits === 0 && !chasing) return 'resolved';
	if (!ESCALATION_CONTEXTS.some((c) => c > last.context)) return 'ladder';
	return null;
}

/** Whether the latest step is worth offering over what is shown: it resolves at
 * least one open end (or, with none added, accounts for missing haplotypes) and
 * stays within every budget. */
export function isImprovement(
	steps: EscalationStep[],
	shown: Unresolved,
	budget: EscalationBudget = DEFAULT_BUDGET
): boolean {
	const step = steps[steps.length - 1];
	if (!step || !step.ok || overBudget(steps, budget) !== null) return false;
	return step.exits < shown.exits || (step.exits <= shown.exits && step.missing < shown.missing);
}

const kb = (bp: number) => (bp >= 1000 ? `${Math.round(bp / 1000)} kb` : `${bp} bp`);

/** The short note shown when the ladder stops on a budget: where the view
 * stays, and what was too large. */
export function budgetNote(steps: EscalationStep[], fromContext: number, budget = DEFAULT_BUDGET): string | null {
	const which = overBudget(steps, budget);
	const last = steps[steps.length - 1];
	if (!which || !last) return null;
	const kept = steps.length > 1 ? steps[steps.length - 2].context : fromContext;
	const what = which === 'nodes' ? 'too many nodes' : which === 'memory' ? 'too much memory' : `too large (${which})`;
	return `Stopped at ${kb(kept)}: the ${kb(last.context)} step was ${what}`;
}

export interface EscalationOffer {
	context: number;
	gfaText: string;
	stats: QueryResult['stats'];
	step: EscalationStep;
	/** Exits on screen now, and how many this result resolves. */
	shown: Unresolved;
}

/**
 * Runs the ladder for one locus on its own worker (so it never queues behind, or
 * blocks, a query the user starts), reporting each step and every improvement.
 * A new `start` or `cancel` abandons the run in flight — terminating its worker
 * if a query is mid-way, since the wasm runs synchronously and can't be told.
 * An idle worker is kept across loci, so its DB reader (header, schema and
 * index pages, warmed once per graph) and its bounded block cache carry over:
 * the ~3.5 MiB open cost is paid once per session, not once per locus.
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
		shown: Unresolved,
		cb: {
			onStep?: (step: EscalationStep) => void;
			/** Every raw result, for logging/measurement. */
			onResult?: (result: QueryResult, context: number) => void;
			onOffer: (offer: EscalationOffer) => void;
			/** `note` is set when a budget stopped the ladder (see budgetNote). */
			onDone?: (reason: string, steps: EscalationStep[], note: string | null) => void;
		},
		budget: EscalationBudget = DEFAULT_BUDGET
	): Promise<void> {
		this.cancel();
		const run = this.runId;
		const steps: EscalationStep[] = [];
		let best = shown;
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
			if (isImprovement(steps, best, budget) && r.gfa) {
				cb.onOffer({
					context,
					gfaText: r.gfa,
					stats: r.stats,
					step,
					shown
				});
				best = { exits: step.exits, missing: step.missing };
			}
			const reason = stopReason(steps, budget, shown);
			if (reason) {
				cb.onDone?.(reason, steps, budgetNote(steps, fromContext, budget));
				return;
			}
		}
		cb.onDone?.('ladder', steps, null);
	}

	terminate() {
		this.cancel();
		this.client?.terminate();
		this.client = null;
	}
}
