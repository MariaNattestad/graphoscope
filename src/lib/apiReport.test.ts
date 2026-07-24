import { describe, expect, it } from 'vitest';
import { parseGfa } from './gfa';
import { graphComplexity } from './apiReport';

// A reduced GFA as `query --format reduced` emits: an X stats line carrying the
// before/after counts, WC coverage on the kept segments, and only the reference
// walk (the non-reference walks are aggregated into the tags). Reference path is
// 1>2>3 spanning 100..150.
const REDUCED = [
	'H\tVN:Z:1.1\tRS:Z:GRCh38',
	'X\tSB:i:1064\tSA:i:35\tLB:i:1476\tLA:i:56\tST:i:334\tNR:i:346\tSN:i:334\tBR:i:386\tUM:i:683\tTW:i:935\tNW:i:933\tNS:i:2\tTS:i:31526',
	'S\t1\tACGT\tWC:i:0',
	'S\t2\tAAAAA\tWC:i:0',
	'S\t3\tCCCC\tWC:i:0',
	'L\t1\t+\t2\t+\t0M\tWC:i:0',
	'L\t2\t+\t3\t+\t0M\tWC:i:0',
	'W\tGRCh38\t0\tchr5\t100\t150\t>1>2>3'
].join('\n');

describe('graphComplexity', () => {
	it('maps the reduced X-line and stats into the report shape', () => {
		const c = graphComplexity(parseGfa(REDUCED), 'GRCh38');
		expect(c.simplified).toBe(true);
		// Post-simplification counts come from the live graph; "before" from the X line.
		expect(c.nodes).toBe(3); // three S lines survive
		expect(c.nodesBeforeSimplification).toBe(1064);
		expect(c.links).toBe(2);
		expect(c.linksBeforeSimplification).toBe(1476);
		// In reduced mode walks/samples read the aggregate totals, not the lone
		// reference W line that's actually present.
		expect(c.walks).toBe(935);
		expect(c.samples).toBe(2);
		expect(c.variantSites).toBe(334);
		expect(c.snps).toBe(334);
		expect(c.nodesRemoved).toBe(346);
		expect(c.basesRemoved).toBe(386);
		expect(c.unchopMerges).toBe(683);
		expect(c.referencePathBp).toBe(50);
	});

	it('marks a plain (non-reduced) GFA as not simplified, with zeroed before-counts', () => {
		const plain = ['S\t1\tACGT', 'S\t2\tGG', 'L\t1\t+\t2\t+\t0M'].join('\n');
		const c = graphComplexity(parseGfa(plain));
		expect(c.simplified).toBe(false);
		expect(c.nodes).toBe(2);
		expect(c.nodesBeforeSimplification).toBe(0);
		expect(c.variantSites).toBe(0);
	});
});
