import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { runFm3, type Fm3LevelSnapshot } from './fm3';
import { looseEnds } from './exitCues';
import c4a from './fixtures/c4a.gfa?raw';
import sitesDemo from './fixtures/sites_demo.gfa?raw';

describe('runFm3 onLevel', () => {
	it('reports every level once, each a partition of the input', () => {
		const nodes = Array.from({ length: 40 }, (_, i) => `n${i}`);
		const edges = nodes.slice(1).map((b, i) => ({ a: nodes[i], b, len: 10 }));
		const levels: Fm3LevelSnapshot[] = [];
		const { pos } = runFm3({ nodes, edges, onLevel: (s) => levels.push(s) });

		expect(levels.map((l) => l.depth)).toEqual([...levels.keys()].reverse());
		const finest = levels.at(-1)!;
		expect(finest.depth).toBe(0);
		expect(finest.pos).toEqual(pos);
		for (const level of levels) {
			const members = [...level.members.values()].flat().sort();
			expect(members).toEqual([...nodes].sort());
			expect([...level.members.keys()].sort()).toEqual([...level.nodes].sort());
		}
	});
});

describe('looseEnds', () => {
	it('finds the window exits in the worked example', () => {
		expect(looseEnds(parseGfa(sitesDemo), 'ref').sort()).toEqual(['64', '65']);
	});

	it('finds the C4 copy-number exits', () => {
		expect(looseEnds(parseGfa(c4a), 'GRCh38')).toHaveLength(8);
	});
});
