import { afterAll, describe, expect, it } from 'vitest';
import { closeSync, copyFileSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { parseGfa } from './gfa';
import {
	INDEX_SIDECARS,
	parsePanSn,
	parseTracks,
	pickTrack,
	refKeyFor,
	regionArgs,
	toWalkGfa,
	type IndexTrack
} from './gfaidx';

describe('parsePanSn', () => {
	it('splits sample#haplotype#contig', () => {
		expect(parsePanSn('HG00097#2#JBIRDE010000062.1')).toEqual({
			sample: 'HG00097',
			haplotype: 2,
			contig: 'JBIRDE010000062.1'
		});
		expect(parsePanSn('CHM13#0#chr21')).toEqual({ sample: 'CHM13', haplotype: 0, contig: 'chr21' });
	});
	it('keeps a # inside the contig, and takes a plain name whole', () => {
		expect(parsePanSn('a#1#b#c')).toEqual({ sample: 'a', haplotype: 1, contig: 'b#c' });
		expect(parsePanSn('chm13#chr1')).toEqual({ sample: 'chm13', haplotype: 0, contig: 'chr1' });
		expect(parsePanSn('ref')).toEqual({ sample: 'ref', haplotype: 0, contig: 'ref' });
	});
});

describe('parseTracks', () => {
	it('reads walks: asked by sample and sequence', () => {
		const [t] = parseTracks('W\tCHM13\t0\tchr2\t237977309\t238045453\t2432\n');
		expect(t).toMatchObject({
			type: 'W',
			sample: 'CHM13',
			haplotype: 0,
			contig: 'chr2',
			name: 'CHM13#0#chr2',
			reference: 'CHM13',
			sequence: 'chr2'
		});
	});
	it('reads paths: asked by their whole name, with no reference', () => {
		const [t] = parseTracks('P\t\t0\tHG00097#2#JBIRDE010000062.1\t-1\t-1\t3107\n');
		expect(t).toMatchObject({
			sample: 'HG00097',
			haplotype: 2,
			contig: 'JBIRDE010000062.1',
			name: 'HG00097#2#JBIRDE010000062.1',
			reference: '',
			sequence: 'HG00097#2#JBIRDE010000062.1'
		});
	});
	it('makes one track of a path cut into fragments', () => {
		const tracks = parseTracks(
			'P\t\t0\tGRCh38#0#chr1:100-200\t-1\t-1\t5\nP\t\t0\tGRCh38#0#chr1:200-300\t-1\t-1\t5\n'
		);
		expect(tracks.map((t) => t.sequence)).toEqual(['GRCh38#0#chr1']);
	});
});

describe('pickTrack', () => {
	const tracks = parseTracks(
		[
			'W\tHG002\t1\tctgA\t0\t10\t1',
			'W\tGRCh38\t0\tchr1\t0\t10\t1',
			'W\tCHM13\t0\tchr1\t0\t10\t1',
			'W\tCHM13\t0\tchr2\t0\t10\t1'
		].join('\n')
	);
	it('defaults to the first reference, not the first assembly', () => {
		expect(pickTrack(tracks, null)?.name).toBe('GRCh38#0#chr1');
	});
	it('takes a full name or a sample, any case', () => {
		expect(pickTrack(tracks, 'chm13#0#chr2')?.name).toBe('CHM13#0#chr2');
		expect(pickTrack(tracks, 'chm13')?.name).toBe('CHM13#0#chr1');
		expect(pickTrack(tracks, 'nobody')).toBeNull();
	});
	it('follows a sample to the contig asked for', () => {
		expect(pickTrack(tracks, 'CHM13', 'chr2')?.name).toBe('CHM13#0#chr2');
		expect(pickTrack(tracks, 'CHM13#0#chr1', 'chr2')?.name).toBe('CHM13#0#chr2');
	});
	it('knows which references have genes', () => {
		expect(refKeyFor(pickTrack(tracks, 'CHM13'))).toBe('chm13');
		expect(refKeyFor(pickTrack(tracks, 'GRCh38'))).toBe('grch38');
		expect(refKeyFor(pickTrack(tracks, 'HG002'))).toBeUndefined();
	});
});

describe('regionArgs', () => {
	const track = parseTracks('P\t\t0\tCHM13#0#chr21\t-1\t-1\t9\n')[0];
	it('asks for haplotype spans by default, and a context search when given one', () => {
		expect(regionArgs({ track, start: 10, end: 20, context: null })).toEqual([
			'--reference', '', '--sequence', 'CHM13#0#chr21', '--begin', '10', '--end', '20', '--mode', 'all'
		]);
		expect(regionArgs({ track, start: 10, end: 20, context: 1000 }).slice(-4)).toEqual([
			'--mode', 'bfs', '--context', '1000'
		]);
	});
});

describe('toWalkGfa', () => {
	it('turns coordinate-bearing paths into named walks and declares the reference', () => {
		const { gfa, walks } = toWalkGfa(
			[
				'H\tVN:Z:1.0',
				'S\t1\tAC',
				'S\t2\tG',
				'L\t1\t+\t2\t-\t0M',
				'P\tCHM13#0#chrM:2906-3200\t1+,2-\t*',
				'P\tHG00097#2#JBIRDE010000062.1:2330-2623\t1+\t*'
			].join('\n'),
			'CHM13'
		);
		expect(walks).toBe(2);
		expect(gfa.split('\n')).toEqual([
			'H\tVN:Z:1.1\tRS:Z:CHM13',
			'S\t1\tAC',
			'S\t2\tG',
			'L\t1\t+\t2\t-\t0M',
			'W\tCHM13\t0\tchrM\t2906\t3200\t>1<2',
			'W\tHG00097\t2\tJBIRDE010000062.1\t2330\t2623\t>1',
			''
		]);
	});
	it('passes walks through unchanged', () => {
		const line = 'W\tNA20129\t1\tJAHEPE010000103.1\t22450\t24697\t>1>2';
		expect(toWalkGfa(`S\t1\tA\n${line}\n`, 'CHM13').gfa).toContain(`\n${line}\n`);
	});
});

// The shipped binary: static/gfaidx.wasm is committed and is what the /gfaidx
// page runs. Here it reads the bundled MLPH index from disk (the page reads the
// same files by range request) and its answer is checked against the GFA the
// index was built from.
describe('gfaidx.wasm on the bundled index', () => {
	const wasmModule = new WebAssembly.Module(readFileSync(new URL('../../static/gfaidx.wasm', import.meta.url)));
	const bundled = fileURLToPath(new URL('../../static/examples/gfaidx/', import.meta.url));
	const source = parseGfa(readFileSync(new URL('../../static/examples/MLPH.chm13.subset.gfa', import.meta.url), 'utf8'));
	const work = mkdtempSync(join(tmpdir(), 'graphoscope-gfaidx-'));
	afterAll(() => rmSync(work, { recursive: true, force: true }));
	// Mounted under the names the worker gives them.
	for (const { suffix } of INDEX_SIDECARS) {
		try {
			copyFileSync(join(bundled, `mlph.gfaidx${suffix}`), join(work, `graph.gfa.gz${suffix}`));
		} catch {
			// an optional sidecar this index doesn't have
		}
	}

	function run(command: string, args: string[] = []): { exitCode: number; out: string; err: string } {
		const outPath = join(work, 'out.txt');
		const errPath = join(work, 'err.txt');
		const out = openSync(outPath, 'w');
		const err = openSync(errPath, 'w');
		let exitCode: number;
		try {
			const wasi = new WASI({
				version: 'preview1',
				args: ['gfaidx-query', command, '/data/graph.gfa.gz', ...args],
				preopens: { '/data': work },
				stdout: out,
				stderr: err,
				returnOnExit: true
			});
			const instance = new WebAssembly.Instance(wasmModule, wasi.getImportObject() as WebAssembly.Imports);
			exitCode = wasi.start(instance);
		} finally {
			closeSync(out);
			closeSync(err);
		}
		return { exitCode, out: readFileSync(outPath, 'utf8'), err: readFileSync(errPath, 'utf8') };
	}

	let tracks: IndexTrack[] = [];
	it('lists every walk of the source graph as a track', () => {
		const result = run('tracks');
		expect(result.exitCode, result.err).toBe(0);
		tracks = parseTracks(result.out);
		const expected = new Set(source.walks.map((w) => `${w.sample}#${w.hapIndex}#${w.seqId}`));
		expect(new Set(tracks.map((t) => t.name))).toEqual(expected);
		expect(tracks.length).toBe(expected.size);
		expect(pickTrack(tracks, null)?.name).toBe('CHM13#0#chr2');
	});

	it('returns a region with every haplotype named, on its own coordinates', () => {
		const track = pickTrack(tracks, 'CHM13')!;
		const result = run('region', regionArgs({ track, start: 238_030_000, end: 238_040_000, context: null }));
		expect(result.exitCode, result.err).toBe(0);
		const region = parseGfa(toWalkGfa(result.out, track.sample).gfa);

		// The reference walk covers what was asked, widened to whole nodes.
		const ref = region.walks.find((w) => w.sample === 'CHM13')!;
		expect(ref.start).toBeLessThanOrEqual(238_030_000);
		expect(ref.end).toBeGreaterThanOrEqual(238_040_000);
		expect(ref.end - ref.start).toBeLessThan(10_500);

		// Names are real samples, and more than one of them.
		const samples = new Set(region.walks.map((w) => w.sample));
		expect(samples.has('GRCh38')).toBe(true);
		expect(samples.size).toBeGreaterThan(10);
		expect(samples.has('unknown')).toBe(false);

		// Each walk is a stretch of that haplotype's walk in the source graph:
		// the same steps, and coordinates that add up to the bases it visits.
		for (const walk of region.walks) {
			// (The source names a few contigs on more than one walk line.)
			const whole = source.walks.filter(
				(w) => w.sample === walk.sample && w.hapIndex === walk.hapIndex && w.seqId === walk.seqId
			);
			expect(whole.length, `${walk.sample}#${walk.hapIndex} is in the source`).toBeGreaterThan(0);
			const steps = walk.steps.map((s) => s.orient + s.id).join('');
			expect(whole.some((w) => w.steps.map((s) => s.orient + s.id).join('').includes(steps))).toBe(true);
			let bp = 0;
			for (const s of walk.steps) {
				const segment = region.segments.get(s.id);
				expect(segment, `node ${s.id} of ${walk.sample} was returned`).toBeDefined();
				expect(segment!.length).toBe(source.segments.get(s.id)!.length);
				bp += segment!.length;
			}
			expect(walk.end - walk.start).toBe(bp);
		}
	});

	it('follows the graph past the region in context mode', () => {
		const track = pickTrack(tracks, 'CHM13')!;
		const spans = run('region', regionArgs({ track, start: 238_035_000, end: 238_036_000, context: null }));
		const context = run('region', regionArgs({ track, start: 238_035_000, end: 238_036_000, context: 2000 }));
		expect(context.exitCode, context.err).toBe(0);
		const count = (text: string) => text.split('\n').filter((l) => l.startsWith('S\t')).length;
		expect(count(context.out)).toBeGreaterThan(count(spans.out));
	});

	it('says why a region off the path has nothing', () => {
		const track = pickTrack(tracks, 'CHM13')!;
		const result = run('region', regionArgs({ track, start: 10, end: 20, context: null }));
		expect(result.exitCode).toBe(1);
		expect(result.err).toMatch(/gfaidx error: /);
	});
});
