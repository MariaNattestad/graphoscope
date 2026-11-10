import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { looseEnds } from './exitCues';
import c4a from './fixtures/c4a.gfa?raw';
import sitesDemo from './fixtures/sites_demo.gfa?raw';

describe('looseEnds', () => {
	it('finds the window exits in the worked example', () => {
		expect(looseEnds(parseGfa(sitesDemo), 'ref').sort()).toEqual(['64', '65']);
	});

	it('finds the C4 copy-number exits', () => {
		expect(looseEnds(parseGfa(c4a), 'GRCh38')).toHaveLength(8);
	});
});
