import { describe, it, expect } from 'vitest';
import { parseGfa, gfaStats } from './gfa';
import { computeNonRefNodes } from './nonRefNodes';
import { gfaToGraph } from './graph/gfaToGraph';
import { buildAndRunLayout } from './graph/forceLayout';

// A tiny reduced GFA (as `query --format reduced` would emit): an X stats line,
// WC coverage tags on segments + links, and only the reference walk. Reference
// path is nodes 1>2>3 (a SNP bubble 2/2b collapsed already isn't shown; here 2
// is an alt kept for the test). Layout: ref 1>2>3, alt node 4 off to the side.
const REDUCED = [
	'H\tVN:Z:1.1\tRS:Z:GRCh38',
	'X\tSB:i:9\tSA:i:5\tLB:i:12\tLA:i:6\tST:i:2\tNR:i:3\tSN:i:2\tBR:i:2\tUM:i:1\tTW:i:20\tNW:i:19\tNS:i:10\tTS:i:120',
	'S\t1\tACGT\tWC:i:0',
	'S\t2\tAAAAA\tWC:i:0',
	'S\t3\tCCCC\tWC:i:0',
	'S\t4\tG\tWC:i:7', // alt node, 7 non-ref walks
	'S\t5\tTTTT\tWC:i:12',
	'L\t1\t+\t2\t+\t0M\tWC:i:0',
	'L\t2\t+\t3\t+\t0M\tWC:i:0',
	'L\t1\t+\t4\t+\t0M\tWC:i:7',
	'L\t4\t+\t3\t+\t0M\tWC:i:7',
	'L\t1\t+\t3\t+\t0M\tWC:i:5', // a pure-deletion skip edge, 5 walks
	'W\tGRCh38\t0\tchr1\t1000\t1013\t>1>2>3'
].join('\n');

describe('reduced GFA consumer pipeline', () => {
	const gfa = parseGfa(REDUCED);

	it('parses the X stats line', () => {
		expect(gfa.reduced).toBeDefined();
		expect(gfa.reduced!.segmentsBefore).toBe(9);
		expect(gfa.reduced!.segmentsAfter).toBe(5);
		expect(gfa.reduced!.sites).toBe(2);
		expect(gfa.reduced!.snpCount).toBe(2);
		expect(gfa.reduced!.unchopMerges).toBe(1);
		expect(gfa.reduced!.totalWalks).toBe(20);
		expect(gfa.reduced!.nonRefWalks).toBe(19);
		expect(gfa.reduced!.samples).toBe(10);
	});

	it('parses WC coverage onto segments and links', () => {
		expect(gfa.segments.get('4')!.coverage).toBe(7);
		expect(gfa.segments.get('5')!.coverage).toBe(12);
		expect(gfa.segments.get('1')!.coverage).toBe(0);
		const skip = gfa.links.find((l) => l.from === '1' && l.to === '3');
		expect(skip!.coverage).toBe(5);
	});

	it('gfaStats uses the reduced totals, not the single reference walk', () => {
		const s = gfaStats(gfa, 'GRCh38');
		expect(s.walks).toBe(20); // not 1 (only the ref walk is present)
		expect(s.samples).toBe(10);
		expect(s.segments).toBe(5);
		expect(s.referencePathBp).toBe(13); // 1013 - 1000
	});

	it('forceLayout coverage comes from WC tags (no non-ref walks needed)', () => {
		const { graph } = gfaToGraph(gfa, { referenceSample: 'GRCh38' });
		const layout = buildAndRunLayout(graph, { referenceSample: 'GRCh38' });
		expect(layout.pathCoverage.get('4')).toBe(7);
		expect(layout.pathCoverage.get('5')).toBe(12);
		expect(layout.maxPathCoverage).toBe(12);
	});

	it('nonRefNodes coverage + totals come from reduced data', () => {
		const model = computeNonRefNodes(gfa, 'GRCh38', 0);
		expect(model).toBeTruthy();
		expect(model!.totalNonRef).toBe(19); // from reduced.nonRefWalks
		// alt node 4 is a non-reference event with WC coverage 7
		const alt = model!.events.find((e) => e.id === '4');
		expect(alt!.cov).toBe(7);
		// pure-deletion skip edge 1>3 uses link WC coverage 5
		const del = model!.events.find((e) => e.id.startsWith('del:'));
		expect(del!.cov).toBe(5);
	});
});
