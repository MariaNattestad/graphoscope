import { afterAll, describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { parseGfa } from './gfa';
import { ALL_FIXTURES } from './graph/fixtures';
import { buildOrigToDisplayed } from './graph/walkIndex';
import { computeBubbles } from './graph/bubbles';
import { gfaToGraph } from './graph/gfaToGraph';
import { buildAndRunLayout } from './graph/forceLayout';
import { buildMsaGrid } from './graph/msa';

// Smoke test for the *shipped* reducer: static/query.wasm is committed, and every
// locus query and the playground run it. This runs that binary in its `--gfa`
// mode (the playground's code path) over each fixture, checks the synthetic ones
// against their pinned expectations, and feeds every reduced graph through the
// viewer's pipeline (bubbles, graph adapter, layout, MSA) to make sure nothing
// downstream throws on real reducer output.

const wasmModule = new WebAssembly.Module(
	readFileSync(new URL('../../static/query.wasm', import.meta.url))
);
const work = mkdtempSync(join(tmpdir(), 'graphoscope-wasm-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// The playground's default threshold, which the fixtures' expectations assume.
const MAX_VARIANT = 50;

function reduce(id: string, gfaText: string): string {
	const dir = mkdtempSync(join(work, `${id}-`));
	writeFileSync(join(dir, 'input.gfa'), gfaText);
	const outPath = join(dir, 'out.gfa');
	const errPath = join(dir, 'err.txt');
	const out = openSync(outPath, 'w');
	const err = openSync(errPath, 'w');
	let exitCode: number;
	try {
		const wasi = new WASI({
			version: 'preview1',
			args: ['query', '--gfa', '/data/input.gfa', '--max-variant', String(MAX_VARIANT)],
			preopens: { '/data': dir },
			stdout: out,
			stderr: err,
			returnOnExit: true
		});
		const instance = new WebAssembly.Instance(
			wasmModule,
			wasi.getImportObject() as WebAssembly.Imports
		);
		exitCode = wasi.start(instance);
	} finally {
		closeSync(out);
		closeSync(err);
	}
	expect(exitCode, `query.wasm exit code for ${id}: ${readFileSync(errPath, 'utf8')}`).toBe(0);
	return readFileSync(outPath, 'utf8');
}

describe('query.wasm --gfa', () => {
	for (const fixture of ALL_FIXTURES) {
		it(`reduces ${fixture.id} and the viewer pipeline handles the result`, () => {
			const reduced = parseGfa(reduce(fixture.id, fixture.gfaText));
			const stats = reduced.reduced;
			expect(stats, 'reduced graph carries its X stats line').toBeTruthy();
			expect(reduced.segments.size).toBeGreaterThan(0);
			expect(reduced.walks.some((w) => w.sample === fixture.referenceSample)).toBe(true);

			const e = fixture.expect;
			if (e) {
				expect(stats!.sites).toBe(e.sites);
				expect(stats!.nodesRemoved).toBe(e.nodesRemoved);
				expect(stats!.snpCount).toBe(e.snpCount);
				expect(stats!.basesRemoved).toBe(e.basesRemoved);
				// A node survives if it's still a segment or was merged into a u-chain.
				const present = buildOrigToDisplayed(reduced);
				for (const id of e.removedNodes ?? []) expect(present.has(id), `${id} removed`).toBe(false);
				for (const id of e.keptNodes ?? []) expect(present.has(id), `${id} kept`).toBe(true);
				if (e.segmentsAfterSimplify != null)
					expect(reduced.segments.size).toBe(e.segmentsAfterSimplify);
			}

			// Downstream of the reducer: everything a locus view computes on load.
			const ref = fixture.referenceSample;
			computeBubbles(reduced, ref);
			const { graph } = gfaToGraph(reduced, { referenceSample: ref });
			const layout = buildAndRunLayout(graph, {
				referenceSample: ref,
				iterations: 60,
				targetTotalSubNodes: 400
			});
			expect(layout.nodesById.size).toBeGreaterThan(0);
			for (const n of layout.nodesById.values()) {
				expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
			}
			const refWalk = reduced.walks.find((w) => w.sample === ref)!;
			const mid = refWalk.steps[Math.floor(refWalk.steps.length / 2)].id;
			buildMsaGrid(reduced, { referenceSample: ref, selectedSegId: mid, windowBp: 2000 });
		});
	}
});
