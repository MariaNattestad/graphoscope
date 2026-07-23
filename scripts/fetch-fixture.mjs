// Fetches a locus from a hosted .gbz.db and writes it as a playground fixture.
//
// This runs the same wasm the browser runs, over the same HTTP range requests,
// just from the command line — so a fixture is byte-for-byte what a user would
// get from that locus. The browser's VFS uses synchronous XHR, which Node has no
// equivalent of, so range reads shell out to curl (WASI's fd_read is
// synchronous, so the read cannot be async).
//
// Usage:
//   node scripts/fetch-fixture.mjs GENE [--ref grch38|chm13] [--out FILE] [--raw]
//
// Without --raw it writes the reduced GFA; with it, the unsimplified subgraph
// (which is what the playground's "original" side wants to show).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	WASI,
	WASIProcExit,
	Fd,
	File as WasiFile,
	OpenFile,
	PreopenDirectory,
	wasi
} from '@bjorn3/browser_wasi_shim';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const R2 = 'https://pub-32138fb437f04b75ac10fea079052edb.r2.dev';
const DBS = {
	grch38: { url: `${R2}/hprc-v2.0-mc-grch38.gbz.db`, sample: 'GRCh38' },
	chm13: { url: `${R2}/hprc-v2.0-mc-chm13.gbz.db`, sample: 'CHM13' }
};
const BLOCK = 1 << 16; // 64 KiB, matching src/lib/vfs.ts

function curlRange(url, start, end) {
	return execFileSync('curl', ['-s', '-r', `${start}-${end}`, url], {
		maxBuffer: 1 << 28,
		encoding: 'buffer'
	});
}

function contentLength(url) {
	const head = execFileSync('curl', ['-s', '-I', url], { encoding: 'utf8' });
	const m = head.match(/content-length:\s*(\d+)/i);
	if (!m) throw new Error(`no content-length for ${url}`);
	return Number(m[1]);
}

/** A WASI file backed by 64 KiB range requests, with a simple block cache.
 * Mirrors LazyFile/LazyOpenFile in src/lib/vfs.ts — same interface the browser
 * uses, so the wasm sees exactly what it sees in the app. */
class RangeFile extends WasiFile {
	constructor(url) {
		super(new Uint8Array(0), { readonly: true });
		this.url = url;
		this.total = contentLength(url);
		this.blocks = new Map();
		this.reads = 0;
	}
	get size() {
		return BigInt(this.total);
	}
	block(i) {
		let b = this.blocks.get(i);
		if (!b) {
			const start = i * BLOCK;
			const end = Math.min(start + BLOCK, this.total) - 1;
			b = new Uint8Array(curlRange(this.url, start, end));
			this.blocks.set(i, b);
			this.reads++;
			if (this.reads % 25 === 0) process.stderr.write(`  ${this.reads} range reads…\n`);
		}
		return b;
	}
	readRange(offset, len) {
		const out = new Uint8Array(Math.max(0, Math.min(len, this.total - offset)));
		let done = 0;
		while (done < out.length) {
			const pos = offset + done;
			const bi = Math.floor(pos / BLOCK);
			const b = this.block(bi);
			const within = pos - bi * BLOCK;
			const n = Math.min(b.length - within, out.length - done);
			if (n <= 0) break;
			out.set(b.subarray(within, within + n), done);
			done += n;
		}
		return out;
	}
	stat() {
		return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, this.size);
	}
	path_open() {
		return { ret: wasi.ERRNO_SUCCESS, fd_obj: new RangeOpenFile(this) };
	}
}

class RangeOpenFile extends OpenFile {
	constructor(file) {
		super(file);
	}
	fd_read(size) {
		const data = this.file.readRange(Number(this.file_pos), size);
		this.file_pos += BigInt(data.length);
		return { ret: 0, data };
	}
	fd_pread(size, offset) {
		return { ret: 0, data: this.file.readRange(Number(offset), size) };
	}
	fd_seek(offset, whence) {
		let next;
		switch (whence) {
			case wasi.WHENCE_SET: next = offset; break;
			case wasi.WHENCE_CUR: next = this.file_pos + offset; break;
			case wasi.WHENCE_END: next = this.file.size + offset; break;
			default: return { ret: wasi.ERRNO_INVAL, offset: 0n };
		}
		if (next < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
		this.file_pos = next;
		return { ret: 0, offset: this.file_pos };
	}
	fd_filestat_get() {
		return { ret: 0, filestat: this.file.stat() };
	}
}

class CollectorFd extends Fd {
	constructor() {
		super();
		this.chunks = [];
	}
	fd_write(data) {
		this.chunks.push(Uint8Array.from(data));
		return { ret: 0, nwritten: data.byteLength };
	}
	fd_fdstat_get() {
		const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
		fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
		return { ret: 0, fdstat };
	}
	fd_filestat_get() {
		return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
	}
	text() {
		return Buffer.concat(this.chunks.map((c) => Buffer.from(c))).toString('utf8');
	}
}

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const gene = argv.find((a) => !a.startsWith('--'));
const flag = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? def : argv[i + 1];
};
const refKey = flag('ref', 'grch38');
const raw = argv.includes('--raw');
if (!gene) {
	console.error('Usage: node scripts/fetch-fixture.mjs GENE [--ref grch38|chm13] [--out FILE] [--raw]');
	process.exit(1);
}
const db = DBS[refKey];
if (!db) throw new Error(`unknown --ref ${refKey}`);

// Resolve the gene through the same map the app ships.
const genes = JSON.parse(readFileSync(resolve(ROOT, `static/genes/genes-${refKey}.json`), 'utf8'));
const entry = genes[gene.toUpperCase()] ?? genes[gene];
if (!entry) throw new Error(`gene ${gene} not found in genes-${refKey}.json`);
const [contig, gStart, gEnd] = entry;
// Match the app's window: at least 20 kb, centred on the gene (see geneToLocus).
const MIN = 20000;
const pad = Math.max(0, MIN - (gEnd - gStart)) / 2;
const start = Math.max(0, Math.round(gStart - pad));
const end = Math.round(gEnd + pad);

console.error(`${gene} (${refKey}) → ${contig}:${start}-${end}`);

const file = new RangeFile(db.url);
const stdout = new CollectorFd();
const stderr = new CollectorFd();
const args = [
	'query',
	'--sample',
	db.sample,
	'--contig',
	contig,
	'--interval',
	`${start}..${end}`,
	...(raw ? ['--raw'] : []),
	'/data/graph.db'
];
const wasiInstance = new WASI(
	args,
	[],
	[
		new OpenFile(new WasiFile(new Uint8Array(0))),
		stdout,
		stderr,
		new PreopenDirectory('/data', new Map([['graph.db', file]]))
	],
	{ debug: false }
);

const module = await WebAssembly.compile(readFileSync(resolve(ROOT, 'static/query.wasm')));
const instance = await WebAssembly.instantiate(module, {
	wasi_snapshot_preview1: wasiInstance.wasiImport
});
let code = 0;
try {
	code = wasiInstance.start(instance);
} catch (e) {
	if (e instanceof WASIProcExit) code = e.code;
	else throw e;
}
if (code !== 0) {
	console.error(stderr.text());
	process.exit(code);
}

const out = flag('out', resolve(ROOT, `src/lib/graph/fixtures/${gene.toLowerCase()}.gfa`));
const text = stdout.text();
writeFileSync(out, text);
console.error(
  `wrote ${out} — ${(text.length / 1024).toFixed(0)} KB, ${file.reads} range reads, ` +
  `${text.split('\n').filter((l) => l.startsWith('S')).length} segments`
);
