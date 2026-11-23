import { describe, expect, it } from 'vitest';
import { closeSync, existsSync, fstatSync, openSync, readSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { WASI, WASIProcExit, Fd, File as WasiFile, OpenFile, PreopenDirectory, wasi, type Inode } from '@bjorn3/browser_wasi_shim';
import { INDEX_SIDECARS, parseTracks, pickTrack, regionArgs } from './gfaidx';
import { PlanOverflow, SparseFile, SparseOpenFile, SparseRangeReader, runPlanned } from './sparseVfs';

describe('SparseRangeReader', () => {
	const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7 + 3) % 251);
	const reader = () => {
		const calls: [number, number][] = [];
		const r = new SparseRangeReader(bytes.length, async (start, end) => {
			calls.push([start, end]);
			return bytes.slice(start, end);
		});
		return { r, calls };
	};

	it('answers a missed read with zeros, then with the bytes once fetched', async () => {
		const { r, calls } = reader();
		expect(r.readRange(5000, 10)).toEqual(new Uint8Array(10));
		expect(r.missing).toBe(1);
		await r.fetchWanted();
		expect(r.missing).toBe(0);
		expect(r.readRange(5000, 10)).toEqual(bytes.slice(5000, 5010));
		// A lone read is fetched from its 4 KiB grain on, with what lies ahead.
		expect(calls).toEqual([[4096, 100_000]]);
		expect(r.readRange(8000, 100)).toEqual(bytes.slice(8000, 8100));
		expect(r.missing).toBe(0);
	});

	it('fetches many scattered reads exactly, near ones as one request', async () => {
		const big = new Uint8Array(40_000_000);
		const calls: [number, number][] = [];
		const r = new SparseRangeReader(big.length, async (start, end) => {
			calls.push([start, end]);
			return big.slice(start, end);
		});
		// 200 reads a megabyte apart, and one more right beside the first.
		for (let i = 0; i < 200; i++) r.readRange(1000 + i * 100_000, 50);
		r.readRange(9000, 10);
		await r.fetchWanted();
		calls.sort((a, b) => a[0] - b[0]);
		expect(calls.length).toBe(200);
		expect(calls[0]).toEqual([0, 12288]);
		expect(calls[1]).toEqual([98304, 102400]);
		// A page each (two where a read straddles a page boundary), not a block each.
		expect(r.bytesFetched).toBeLessThan(210 * 4096);
	});

	it('joins pieces that touch, so a read across them is served', async () => {
		const { r } = reader();
		r.insert(0, bytes.slice(0, 4096));
		r.insert(8192, bytes.slice(8192, 12288));
		expect(r.readRange(4000, 200)).toEqual(new Uint8Array(200)); // spans a hole
		r.insert(4096, bytes.slice(4096, 8192));
		expect(r.readRange(4000, 200)).toEqual(bytes.slice(4000, 4200));
		expect(r.readRange(0, 12288)).toEqual(bytes.slice(0, 12288));
		// Overlapping inserts keep the bytes right.
		r.insert(10_000, bytes.slice(10_000, 20_000));
		expect(r.readRange(9000, 11_000)).toEqual(bytes.slice(9000, 20_000));
	});

	it('clamps to the end of the file', async () => {
		const { r } = reader();
		r.readRange(99_990, 100);
		await r.fetchWanted();
		expect(r.readRange(99_990, 100)).toEqual(bytes.slice(99_990));
		expect(r.readRange(200_000, 10).length).toBe(0);
	});
});

describe('runPlanned', () => {
	it('repeats a run until it has read only real bytes, one round per level of dependence', async () => {
		// A file where each read says where the next is: three levels deep.
		const file = new Uint8Array(3_000_000);
		const view = new DataView(file.buffer);
		view.setUint32(0, 1_000_000, true);
		view.setUint32(1_000_000, 2_500_000, true);
		view.setUint32(2_500_000, 42, true);
		const r = new SparseRangeReader(file.length, async (s, e) => file.slice(s, e));
		const at = (offset: number) => new DataView(r.readRange(offset, 4).buffer).getUint32(0, true);
		const { result, rounds } = await runPlanned([r], () => at(at(at(0))));
		expect(result).toBe(42);
		expect(rounds).toBe(3);
	});

	it('after a run gone astray on zeros, fetches only its earliest misses', async () => {
		// A binary search: on zeros it keeps reading, ever further, until it has
		// asked for more than a round may fetch. Its first reads were real.
		const n = 1 << 20;
		const file = new Uint8Array(n * 4);
		const view = new DataView(file.buffer);
		for (let i = 0; i < n; i++) view.setUint32(i * 4, i * 2, true);
		const r = new SparseRangeReader(file.length, async (s, e) => file.slice(s, e));
		const at = (i: number) => new DataView(r.readRange(i * 4, 4).buffer).getUint32(0, true);
		const { result, rounds } = await runPlanned([r], () => {
			let lo = 0;
			let hi = n;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (at(mid) < 777_000) lo = mid + 1;
				else hi = mid;
			}
			// Gone astray: a scan over 30 000 far-apart entries.
			if (lo >= n || at(lo) !== 777_000) for (let i = 0; i < 30_000; i++) at((i * 7919) % n);
			return lo;
		});
		expect(result).toBe(388_500);
		expect(rounds).toBeLessThan(30);
	});

	it('passes on a failure that real bytes produce', async () => {
		const r = new SparseRangeReader(10, async (s, e) => new Uint8Array(e - s));
		await expect(
			runPlanned([r], () => {
				r.readRange(0, 4);
				throw new Error('bad index');
			})
		).rejects.toThrow('bad index');
	});
});

// gfaidx.wasm over files it can only reach through the planner, as in the
// browser. Local files stand in for the remote ones, so what is counted is what
// the page would fetch.
async function planned(graphPath: string) {
	const wasmModule = new WebAssembly.Module(
		readFileSync(process.env.GFAIDX_WASM ?? new URL('../../static/gfaidx.wasm', import.meta.url))
	);
	const readers = new Map<string, SparseRangeReader>();
	const fds: number[] = [];
	for (const { suffix } of INDEX_SIDECARS) {
		// A remote index (as the page reads it), for timing against a real host.
		if (/^https?:/.test(graphPath)) {
			if (suffix !== '.cdx') readers.set(suffix, await SparseRangeReader.open(graphPath + suffix));
			continue;
		}
		if (!existsSync(graphPath + suffix)) continue;
		const fd = openSync(graphPath + suffix, 'r');
		fds.push(fd);
		readers.set(
			suffix,
			new SparseRangeReader(fstatSync(fd).size, async (start, end) => {
				const buf = new Uint8Array(end - start);
				readSync(fd, buf, 0, buf.length, start);
				return buf;
			})
		);
	}
	class Collector extends Fd {
		chunks: Uint8Array[] = [];
		fd_write(data: Uint8Array) {
			this.chunks.push(data.slice());
			return { ret: 0, nwritten: data.byteLength };
		}
		fd_fdstat_get() {
			const s = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
			s.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
			return { ret: 0, fdstat: s };
		}
		text() {
			return Buffer.concat(this.chunks).toString();
		}
	}
	async function run(command: string, args: string[] = []) {
		const all = [...readers.values()];
		// As when a remote file is opened: its head and tail come first.
		if (all.every((r) => r.requestCount === 0)) await Promise.all(all.map((r) => r.seed()));
		const before = all.reduce((sum, r) => sum + r.requestCount, 0);
		const bytesBefore = all.reduce((sum, r) => sum + r.bytesFetched, 0);
		const { result, rounds } = await runPlanned(all, () => {
			const stdout = new Collector();
			const stderr = new Collector();
			const files = new Map<string, Inode>();
			for (const [suffix, reader] of readers) files.set(`graph.gfa.gz${suffix}`, new SparseFile(reader));
			const shim = new WASI(
				['gfaidx-query', command, '/data/graph.gfa.gz', ...args],
				[],
				[new OpenFile(new WasiFile(new Uint8Array(0))), stdout, stderr, new PreopenDirectory('/data', files)],
				{ debug: false }
			);
			const imports = {
				...shim.wasiImport,
				fd_advise(fd: number, offset: bigint, length: bigint) {
					const open = shim.fds[fd];
					if (open instanceof SparseOpenFile) open.advise(offset, length);
					return wasi.ERRNO_SUCCESS;
				}
			};
			const instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: imports });
			let exitCode = 0;
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				exitCode = shim.start(instance as any);
			} catch (e) {
				if (e instanceof WASIProcExit) exitCode = e.code;
				else if (e instanceof PlanOverflow) throw e;
				else return { exitCode: -1, out: '', err: String(e) };
			}
			return { exitCode, out: stdout.text(), err: stderr.text() };
		}, Number(process.env.GFAIDX_MAX_ROUNDS ?? 64), (round) => {
			if (!process.env.GFAIDX_TRACE) return;
			const parts = [...readers].filter(([, r]) => r.missing > 0).map(([suffix, r]) => {
				const lo = Math.min(...r.missed.map((m) => m[0]));
				const hi = Math.max(...r.missed.map((m) => m[1]));
				const sum = r.missed.reduce((s, m) => s + m[1] - m[0], 0);
				return `${suffix || 'graph'}: ${r.missing} reads ${sum} B in [${lo}, ${hi})`;
			});
			console.log(`round ${round}: ${parts.join('; ')}`);
		});
		return {
			...result,
			rounds,
			requests: all.reduce((sum, r) => sum + r.requestCount, 0) - before,
			bytes: all.reduce((sum, r) => sum + r.bytesFetched, 0) - bytesBefore
		};
	}
	return { run, close: () => fds.forEach((fd) => closeSync(fd)) };
}

describe('gfaidx.wasm through the planner', () => {
	const bundled = fileURLToPath(new URL('../../static/examples/gfaidx/mlph.gfaidx', import.meta.url));

	it('gives the same region as reading the files directly, in a few rounds', async () => {
		const index = await planned(bundled);
		try {
			const tracks = await index.run('tracks');
			expect(tracks.exitCode, tracks.err).toBe(0);
			const track = pickTrack(parseTracks(tracks.out), 'CHM13')!;
			const args = regionArgs({ track, start: 238_030_000, end: 238_040_000 });
			const region = await index.run('region', args);
			expect(region.exitCode, region.err).toBe(0);
			expect(region.rounds).toBeLessThan(12);

			// The same query with every byte on hand from the start.
			const whole = await planned(bundled);
			try {
				const direct = await whole.run('region', args);
				expect(region.out).toBe(direct.out);
				expect(region.out.split('\n').filter((l) => l.startsWith('W\t')).length).toBeGreaterThan(30);
			} finally {
				whole.close();
			}
			// A second query nearby reuses what the first fetched.
			const again = await index.run('region', args);
			expect(again.rounds).toBe(0);
			expect(again.requests).toBe(0);
		} finally {
			index.close();
		}
	});

	it('reports a real failure once the bytes are real', async () => {
		const index = await planned(bundled);
		try {
			const tracks = await index.run('tracks');
			const track = pickTrack(parseTracks(tracks.out), 'CHM13')!;
			const off = await index.run('region', regionArgs({ track, start: 10, end: 20 }));
			expect(off.exitCode).toBe(1);
			expect(off.err).toMatch(/gfaidx error: /);
		} finally {
			index.close();
		}
	});

	// A chromosome-scale index, when one is on this machine:
	//   GFAIDX_TEST_INDEX=/path/graph.gfa.gz GFAIDX_TEST_PATH='CHM13#0#chr21' \
	//   GFAIDX_TEST_REGION=30022295-30042295 npx vitest run src/lib/sparseVfs.test.ts
	const big = process.env.GFAIDX_TEST_INDEX;
	it.skipIf(!big)('costs a large index a few rounds and a few MB', async () => {
		const index = await planned(big!);
		try {
			const tracks = await index.run('tracks');
			expect(tracks.exitCode, tracks.err).toBe(0);
			const track = pickTrack(parseTracks(tracks.out), process.env.GFAIDX_TEST_PATH ?? null)!;
			const [start, end] = (process.env.GFAIDX_TEST_REGION ?? '').split('-').map(Number);
			const fresh = await planned(big!);
			try {
				const t0 = performance.now();
				const region = await fresh.run('region', regionArgs({ track, start, end }));
				console.log(`${Math.round(performance.now() - t0)} ms`);
				console.log(
					`${track.name}:${start}-${end}: ${region.rounds} rounds, ${region.requests} requests, ` +
						`${(region.bytes / 1048576).toFixed(2)} MB, ${region.out.length} bytes out (sha1 ${createHash('sha1').update(region.out).digest('hex').slice(0, 12)}), exit ${region.exitCode}`
				);
				expect(region.exitCode, region.err).toBe(0);
			} finally {
				fresh.close();
			}
			console.log(`tracks: ${tracks.rounds} rounds, ${tracks.requests} requests, ${(tracks.bytes / 1048576).toFixed(2)} MB`);
		} finally {
			index.close();
		}
	}, 600_000);
});
