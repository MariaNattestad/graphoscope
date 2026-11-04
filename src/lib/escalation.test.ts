import { describe, expect, it } from 'vitest';
import { isImprovement, stepOf, stopReason, type EscalationStep } from './escalation';
import { parseGfa, reducedStatsOf } from './gfa';

const X =
	'X\tSB:i:10\tSA:i:5\tLB:i:9\tLA:i:4\tST:i:0\tNR:i:0\tSN:i:0\tBR:i:0\tUM:i:0\tTW:i:3\tNW:i:2\tNS:i:2\tWR:i:3\tTS:i:50' +
	'\tQS:i:1030\tQE:i:1050\tFN:i:20\tDN:i:10\tLR:i:2\tKA:i:3\tXL:i:0\tXR:i:30\tRJ:i:1\tEX:i:4\tEN:i:2';
const GFA = ['H\tVN:Z:1.1\tRS:Z:ref', X, 'S\t1\tACGT\tWC:i:0', 'W\tref\t0\tchr1\t1030\t1034\t>1'].join('\n');

function step(over: Partial<EscalationStep>): EscalationStep {
	return {
		context: 10_000,
		ok: true,
		exits: 0,
		rejoins: 0,
		extLeftBp: 0,
		extRightBp: 0,
		fetchedNodes: 100,
		nodesShown: 10,
		bytesFetched: 1024,
		requestCount: 5,
		elapsedMs: 100,
		wasmMemoryBytes: 1 << 20,
		gfaBytes: 1000,
		...over
	};
}

describe('locus trim stats', () => {
	it('are parsed from the X line, by the full parser and the cheap one alike', () => {
		const full = parseGfa(GFA).reduced?.locus;
		const cheap = reducedStatsOf(GFA)?.locus;
		expect(full).toEqual(cheap);
		expect(full).toMatchObject({ queryStart: 1030, extRightBp: 30, rejoins: 1, exitEdges: 4, exitNodes: 2 });
	});
	it('are absent on untrimmed output', () => {
		expect(reducedStatsOf(GFA.replace(/\tQS:i:.*$/m, ''))?.locus).toBeUndefined();
	});
	it('feed an escalation step', () => {
		const s = stepOf(50_000, { id: 1, ok: true, gfa: GFA, stats: { requestCount: 3, bytesFetched: 9, dbSize: 1, elapsedMs: 5 } });
		expect(s).toMatchObject({ context: 50_000, ok: true, exits: 4, fetchedNodes: 20, bytesFetched: 9 });
	});
});

describe('stopReason', () => {
	it('stops once nothing leaves the locus unresolved', () => {
		expect(stopReason([step({ exits: 0 })])).toBe('resolved');
	});
	it('keeps going while exits remain and the ladder has rungs', () => {
		expect(stopReason([step({ exits: 3, context: 10_000 })])).toBeNull();
	});
	it('stops at the top of the ladder', () => {
		expect(stopReason([step({ exits: 3, context: 100_000 })])).toBe('ladder');
	});
	it('stops on any budget', () => {
		expect(stopReason([step({ exits: 3, fetchedNodes: 1e9 })])).toBe('budget');
		expect(stopReason([step({ exits: 3, wasmMemoryBytes: 4e9 })])).toBe('budget');
		expect(stopReason([step({ exits: 3, bytesFetched: 100e6 }), step({ exits: 3, bytesFetched: 100e6 })])).toBe('budget');
	});
	it('stops when the result is too big to show, even if resolved', () => {
		expect(stopReason([step({ exits: 0, nodesShown: 1e6 })])).toBe('budget');
	});
	it('stops on an error', () => {
		expect(stopReason([step({ ok: false })])).toBe('error');
	});
});

describe('isImprovement', () => {
	it('needs fewer exits than are shown', () => {
		expect(isImprovement(step({ exits: 2 }), 5)).toBe(true);
		expect(isImprovement(step({ exits: 5 }), 5)).toBe(false);
	});
	it('never offers a graph too large to render', () => {
		expect(isImprovement(step({ exits: 0, gfaBytes: 1e9 }), 5)).toBe(false);
		expect(isImprovement(step({ exits: 0, nodesShown: 1e6 }), 5)).toBe(false);
	});
});
