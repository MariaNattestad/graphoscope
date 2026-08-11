import { describe, expect, it } from 'vitest';
import { parseGfa } from '../gfa';
import { gfaToGraph } from './gfaToGraph';
import { buildAndRunLayout } from './forceLayout';
import { LAYOUT_MODES } from './layoutModes';
import { ALL_FIXTURES } from './fixtures';

// Exercises every layout mode over every fixture: each must produce a finite,
// non-degenerate set of node positions, and the reference-free modes must lay
// the graph out differently from the anchored default (otherwise they're not
// pulling their weight). This is also where the modes get eyeballed — run with
// `npx vitest run forceLayout.modes` and read the printed extent table.

interface Extent {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	w: number;
	h: number;
	n: number;
}

function extentOf(gfaText: string, referenceSample: string, mode: string): Extent {
	const graph = gfaToGraph(parseGfa(gfaText), { referenceSample }).graph;
	// Cheaper sim than the app's defaults — enough to relax into shape for a
	// geometry check, fast enough to run every mode × fixture in the suite.
	const layout = buildAndRunLayout(graph, {
		referenceSample,
		mode: mode as never,
		iterations: 120,
		targetTotalSubNodes: 600
	});
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let n = 0;
	for (const node of layout.nodesById.values()) {
		expect(Number.isFinite(node.x), `${mode} x finite`).toBe(true);
		expect(Number.isFinite(node.y), `${mode} y finite`).toBe(true);
		minX = Math.min(minX, node.x);
		maxX = Math.max(maxX, node.x);
		minY = Math.min(minY, node.y);
		maxY = Math.max(maxY, node.y);
		n++;
	}
	return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, n };
}

// Parse each fixture once; the big real loci are expensive to parse, let alone
// lay out, so cache sizes and reuse.
const FIXTURE_SIZES = new Map(ALL_FIXTURES.map((f) => [f.id, parseGfa(f.gfaText).segments.size]));

describe('layout modes', () => {
	it('produce finite, non-degenerate positions for every fixture', () => {
		for (const fixture of ALL_FIXTURES) {
			// Skip the large real loci — they run the heavy full sim and this test only
			// needs to prove correctness on graphs with real structure.
			if ((FIXTURE_SIZES.get(fixture.id) ?? 0) > 400) continue;
			for (const mode of LAYOUT_MODES) {
				const e = extentOf(fixture.gfaText, fixture.referenceSample, mode.id);
				expect(e.n, `${fixture.id}/${mode.id} has nodes`).toBeGreaterThan(0);
				// A layout collapsed to a single point is a bug (except a 1-node graph).
				if (e.n > 3) {
					expect(e.w + e.h, `${fixture.id}/${mode.id} not collapsed`).toBeGreaterThan(1);
				}
			}
		}
	}, 60000);

	it('lay reference-free modes out differently from classic', () => {
		// Use a fixture with real bubble structure so the modes have something to
		// disagree about.
		const fixture = ALL_FIXTURES.find((f) => f.id === 'multiallelic') ?? ALL_FIXTURES[0];
		const classic = extentOf(fixture.gfaText, fixture.referenceSample, 'classic');
		for (const mode of LAYOUT_MODES.filter((m) => m.family === 'free')) {
			const e = extentOf(fixture.gfaText, fixture.referenceSample, mode.id);
			const aspectClassic = classic.w / Math.max(1, classic.h);
			const aspectFree = e.w / Math.max(1, e.h);
			// Different enough in shape that it isn't just the anchored layout again.
			expect(
				Math.abs(aspectClassic - aspectFree) > 0.05 || Math.abs(e.h - classic.h) > 1,
				`${mode.id} differs from classic`
			).toBe(true);
		}
	}, 60000);

	it('prints an extent table for eyeballing', () => {
		const rows: string[] = [];
		const picks = ['multiallelic', 'nested', 'c4a', 'smn1'].filter((id) =>
			ALL_FIXTURES.some((f) => f.id === id)
		);
		for (const id of picks) {
			const fixture = ALL_FIXTURES.find((f) => f.id === id)!;
			if ((FIXTURE_SIZES.get(id) ?? 0) > 1200) continue;
			for (const mode of LAYOUT_MODES) {
				const e = extentOf(fixture.gfaText, fixture.referenceSample, mode.id);
				rows.push(
					`${id.padEnd(14)} ${mode.id.padEnd(13)} n=${String(e.n).padStart(5)}  ` +
						`w=${Math.round(e.w).toString().padStart(7)}  h=${Math.round(e.h)
							.toString()
							.padStart(7)}  aspect=${(e.w / Math.max(1, e.h)).toFixed(2)}`
				);
			}
			rows.push('');
		}
		console.log('\n' + rows.join('\n'));
		expect(rows.length).toBeGreaterThan(0);
	}, 60000);
});
