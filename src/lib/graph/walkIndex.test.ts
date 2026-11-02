import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { computeBubbles } from './bubbles';
import {
	buildOrigToDisplayed,
	buildWalkIndex,
	countDistinctTraces,
	countWalks
} from './walkIndex';

// A deletion taken by several walks, some of which also carry a small popped
// variant right next to the deletion's junctions (the C4A case: 17 walks take a
// 6.4 kb deletion, but they project to only 2 distinct paths once their popped
// SNPs are dropped, and walk mode used to report 2).
//
// Full graph: reference 1→2→3→4→5→6→7 (node 4 is the deleted stretch), with SNP
// alts 2s (of 2, just left of the deletion) and 6s (of 6, just right of it).
function seq(n: number): string {
	return 'A'.repeat(n);
}
const TAKES_DELETION = [
	'>1>2>3>5>6>7',
	'>1>2s>3>5>6>7', // popped SNP next to the left junction
	'>1>2>3>5>6s>7', // popped SNP next to the right junction
	'>1>2s>3>5>6s>7', // both
	'<7<6s<5<3<2<1' // reverse strand
];
const KEEPS_REFERENCE = ['>1>2>3>4>5>6>7', '>1>2s>3>4>5>6>7'];

const FULL = [
	'H\tVN:Z:1.1',
	...['1', '2', '2s', '3', '5', '6', '6s', '7'].map((id) => `S\t${id}\t${seq(10)}`),
	`S\t4\t${seq(500)}`,
	...[
		['1', '2'],
		['1', '2s'],
		['2', '3'],
		['2s', '3'],
		['3', '4'],
		['4', '5'],
		['3', '5'], // the deletion
		['5', '6'],
		['5', '6s'],
		['6', '7'],
		['6s', '7']
	].map(([a, b]) => `L\t${a}\t+\t${b}\t+\t0M`),
	'W\tREF\t0\tchr1\t1000\t1560\t>1>2>3>4>5>6>7',
	...[...TAKES_DELETION, ...KEEPS_REFERENCE].map(
		(path, i) => `W\tS${i}\t1\tchr1\t0\t0\t${path}`
	)
].join('\n');

// What the reducer makes of it: the SNPs are popped, and the reference runs either
// side of the deletion are unchopped into u1 (1,2,3) and u5 (5,6,7). Coverage
// tags count all seven non-reference walks plus the reference.
const REDUCED = [
	'H\tVN:Z:1.1\tRS:Z:REF',
	`S\tu1\t${seq(30)}\tWC:i:8\tMB:Z:1,2,3`,
	`S\t4\t${seq(500)}\tWC:i:3`,
	`S\tu5\t${seq(30)}\tWC:i:8\tMB:Z:5,6,7`,
	'L\tu1\t+\t4\t+\t0M\tWC:i:3',
	'L\t4\t+\tu5\t+\t0M\tWC:i:3',
	`L\tu1\t+\tu5\t+\t0M\tWC:i:${TAKES_DELETION.length}`,
	'W\tREF\t0\tchr1\t1000\t1560\t>u1>4>u5'
].join('\n');

describe('buildWalkIndex', () => {
	const full = parseGfa(FULL);

	it('counts every walk taking a deletion, not just the distinct projected paths', () => {
		const reduced = parseGfa(REDUCED);
		const skip = computeBubbles(reduced, 'REF')!.bubbles.find((b) => b.isSkip)!;
		expect(skip.coverage).toBe(TAKES_DELETION.length); // what Bubbles mode reports

		const key = `${skip.linkFrom}>${skip.linkTo}`;
		const index = buildWalkIndex(full.walks, buildOrigToDisplayed(reduced), [
			{ key, from: skip.linkFrom, to: skip.linkTo }
		]);
		const traces = index.bySkip.get(key) ?? [];
		expect(countWalks(traces)).toBe(TAKES_DELETION.length);
		// They draw as just two paths: u1→u5 and the reverse-strand u5→u1.
		expect(countDistinctTraces(traces)).toBe(2);
		for (const t of traces) expect(t.map((s) => s.id).sort()).toEqual(['u1', 'u5']);

		// Walks through the deleted stretch are filed under it, and every walk
		// (reference included) touches the flanks.
		expect(countWalks(index.byNode.get('4') ?? [])).toBe(KEEPS_REFERENCE.length + 1);
		expect(index.byNode.get('u1')).toHaveLength(full.walks.length);
	});

	it('agrees with the bubble coverage on the full graph too', () => {
		const skip = computeBubbles(full, 'REF')!.bubbles.find((b) => b.isSkip)!;
		const key = `${skip.linkFrom}>${skip.linkTo}`;
		const index = buildWalkIndex(full.walks, buildOrigToDisplayed(full), [
			{ key, from: skip.linkFrom, to: skip.linkTo }
		]);
		const n = countWalks(index.bySkip.get(key) ?? []);
		expect(n).toBe(TAKES_DELETION.length);
		expect(n).toBe(skip.coverage);
	});
});
