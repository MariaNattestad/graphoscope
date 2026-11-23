// What a gfaidx query would fetch over range requests, measured on local files.
//
// Runs static/gfaidx.wasm the way the /gfaidx page's worker does, but with each
// index file read from disk through a counter: which 64 KiB blocks (the unit
// src/lib/vfs.ts fetches) of which file the query touched. No network, so the
// numbers are the query's own and repeatable.
//
// Usage: node scripts/gfaidx-cost.mjs <graph.gfa.gz> <tracks|region|subgraph> [--flag value ...]
//   e.g. node scripts/gfaidx-cost.mjs chr21.gfa.gz region --reference '' \
//          --sequence 'CHM13#0#chr21' --begin 30022295 --end 30042295 --mode all
import { openSync, readSync, fstatSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WASI, Fd, File, OpenFile, PreopenDirectory, wasi } from '@bjorn3/browser_wasi_shim';

const BLOCK = 1 << 16;
const SUFFIXES = ['', '.idx', '.ndx', '.pdx', '.lnx', '.pcx', '.cdx'];
const [graph, command, ...args] = process.argv.slice(2);
if (!graph || !command) {
	console.error('usage: node scripts/gfaidx-cost.mjs <graph.gfa.gz> <tracks|region|subgraph> [--flag value ...]');
	process.exit(2);
}

class CountedFile extends File {
	constructor(path) {
		super(new Uint8Array(0), { readonly: true });
		this.fd = openSync(path, 'r');
		this.bytes = fstatSync(this.fd).size;
		this.blocks = new Set();
		this.reads = 0;
		this.ranges = [];
	}
	get size() {
		return BigInt(this.bytes);
	}
	stat() {
		return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, this.size);
	}
	read(offset, length) {
		const n = Math.max(0, Math.min(length, this.bytes - offset));
		const buf = new Uint8Array(n);
		if (n > 0) readSync(this.fd, buf, 0, n, offset);
		this.reads++;
		if (n > 0) this.ranges.push([offset, offset + n]);
		for (let b = Math.floor(offset / BLOCK); b <= Math.floor((offset + Math.max(n, 1) - 1) / BLOCK); b++) this.blocks.add(b);
		return buf;
	}
	path_open() {
		return { ret: wasi.ERRNO_SUCCESS, fd_obj: new CountedOpenFile(this) };
	}
}
class CountedOpenFile extends OpenFile {
	fd_read(size) {
		const data = this.file.read(Number(this.file_pos), size);
		this.file_pos += BigInt(data.length);
		return { ret: 0, data };
	}
	fd_pread(size, offset) {
		return { ret: 0, data: this.file.read(Number(offset), size) };
	}
	fd_seek(offset, whence) {
		const next =
			whence === wasi.WHENCE_SET ? offset : whence === wasi.WHENCE_CUR ? this.file_pos + offset : this.file.size + offset;
		if (next < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
		this.file_pos = next;
		return { ret: 0, offset: this.file_pos };
	}
	fd_filestat_get() {
		return { ret: 0, filestat: this.file.stat() };
	}
}
class Sink extends Fd {
	bytes = 0;
	chunks = [];
	fd_write(data) {
		this.bytes += data.byteLength;
		if (this.keep) this.chunks.push(Buffer.from(data));
		return { ret: 0, nwritten: data.byteLength };
	}
	fd_fdstat_get() {
		const s = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
		s.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
		return { ret: 0, fdstat: s };
	}
}

const files = new Map();
for (const suffix of SUFFIXES) {
	if (existsSync(graph + suffix)) files.set(`graph.gfa.gz${suffix}`, new CountedFile(graph + suffix));
}
const stdout = new Sink();
const stderr = new Sink();
stderr.keep = true;
const shim = new WASI(
	['gfaidx-query', command, '/data/graph.gfa.gz', ...args],
	[],
	[new OpenFile(new File(new Uint8Array(0))), stdout, stderr, new PreopenDirectory('/data', files)],
	{ debug: false }
);
const wasm = readFileSync(fileURLToPath(new URL('../static/gfaidx.wasm', import.meta.url)));
const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), {
	wasi_snapshot_preview1: shim.wasiImport
});
const t0 = performance.now();
let exitCode = 0;
try {
	exitCode = shim.start(instance);
} catch (e) {
	if (typeof e?.code === 'number') exitCode = e.code;
	else throw e;
}
const ms = Math.round(performance.now() - t0);

const mb = (n) => (n / 1048576).toFixed(2).padStart(9);
// The byte ranges actually read, merged where they touch or lie within `gap`
// of each other: how few requests, and how few bytes, exact ranges would take.
const GAP = 8192;
function merged(ranges) {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out = [];
	for (const [start, end] of sorted) {
		const last = out[out.length - 1];
		if (last && start <= last[1] + GAP) last[1] = Math.max(last[1], end);
		else out.push([start, end]);
	}
	return { count: out.length, bytes: out.reduce((sum, [start, end]) => sum + end - start, 0) };
}
let totalBlocks = 0;
let totalRanges = 0;
let totalExact = 0;
console.log('file      size MB   reads  64K blocks  as blocks MB   exact ranges  exact MB');
for (const [name, f] of files) {
	const exact = merged(f.ranges);
	totalBlocks += f.blocks.size;
	totalRanges += exact.count;
	totalExact += exact.bytes;
	console.log(
		`${(name.replace('graph.gfa.gz', '') || 'graph').padEnd(6)}${mb(f.bytes)}${String(f.reads).padStart(8)}${String(f.blocks.size).padStart(12)}${mb(Math.min(f.blocks.size * BLOCK, f.bytes)).padStart(14)}${String(exact.count).padStart(15)}${mb(exact.bytes).padStart(10)}`
	);
}
console.log(
	`total: ${totalBlocks} blocks = ${((totalBlocks * BLOCK) / 1048576).toFixed(1)} MB as 64 KiB blocks; ${totalRanges} ranges = ${(totalExact / 1048576).toFixed(2)} MB as exact ranges; output ${stdout.bytes} bytes; ${ms} ms; exit ${exitCode}`
);
if (exitCode !== 0) console.error(Buffer.concat(stderr.chunks).toString().trim().split('\n').slice(-2).join('\n'));
process.exitCode = exitCode;
