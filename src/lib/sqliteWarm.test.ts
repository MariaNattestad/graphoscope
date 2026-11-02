import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSchema, warmGbzDb } from './sqliteWarm';
import type { RangeReader } from './vfs';

const BLOCK = 1 << 16;
const PAGE = 4096;

/** An in-memory RangeReader that counts fetches and records which blocks are
 * cached, so a test can tell what the warm-up pulled in. */
class FakeReader implements RangeReader {
	cached = new Set<number>();
	requestCount = 0;
	bytesFetched = 0;
	constructor(private buf: Uint8Array) {}
	get size() {
		return this.buf.length;
	}
	readRange(offset: number, length: number) {
		return this.buf.subarray(offset, Math.min(offset + length, this.buf.length));
	}
	async prefetch(offset: number, length: number) {
		let first = Math.floor(offset / BLOCK);
		let last = Math.ceil(Math.min(offset + length, this.size) / BLOCK) - 1;
		while (first <= last && this.cached.has(first)) first++;
		while (last >= first && this.cached.has(last)) last--;
		if (first > last) return;
		this.requestCount++;
		for (let b = first; b <= last; b++) this.cached.add(b);
	}
}

const dir = mkdtempSync(join(tmpdir(), 'sqlite-warm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A DB with GBZ-base's schema and a Paths table big enough for a 3-level
 * B-tree. By default each table is created and then filled, the way gbz2db
 * writes them, so Paths sits between its own root and the next table's.
 * `scattered` instead creates every table up front and fills Paths and Nodes
 * together, so that guess covers almost nothing and Paths' pages are spread out. */
function buildDb(name: string, scattered: boolean) {
	const file = join(dir, name);
	const db = new DatabaseSync(file);
	db.exec(`PRAGMA page_size = ${PAGE}`);
	db.exec(`CREATE TABLE Tags (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
	db.exec(`CREATE TABLE Nodes (handle INTEGER PRIMARY KEY, sequence BLOB NOT NULL) STRICT`);
	const node = db.prepare('INSERT INTO Nodes VALUES (?, ?)');
	const fillNodes = (from: number, n: number) => {
		for (let i = from; i < from + n; i++) node.run(i, new Uint8Array(200).fill(i % 251));
	};
	db.exec('BEGIN');
	db.prepare('INSERT INTO Tags VALUES (?, ?)').run('version', 'GBZ-base v0.4.0');
	if (!scattered) fillNodes(0, 3000);
	db.exec(`CREATE TABLE Paths (
		handle INTEGER PRIMARY KEY, fw_node INTEGER NOT NULL, fw_offset INTEGER NOT NULL,
		rev_node INTEGER NOT NULL, rev_offset INTEGER NOT NULL, sample TEXT NOT NULL,
		contig TEXT NOT NULL, haplotype INTEGER NOT NULL, fragment INTEGER NOT NULL,
		is_indexed INTEGER NOT NULL) STRICT`);
	const createRefIndex = () =>
		db.exec(`CREATE TABLE ReferenceIndex (
			path_handle INTEGER NOT NULL, path_offset INTEGER NOT NULL,
			node_handle INTEGER NOT NULL, node_offset INTEGER NOT NULL,
			PRIMARY KEY (path_handle, path_offset)) STRICT`);
	if (scattered) createRefIndex();
	const path = db.prepare('INSERT INTO Paths VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
	for (let i = 0; i < 60000; i++) {
		path.run(i, i * 7, 0, i * 7 + 1, 0, `HG${String(i % 232).padStart(5, '0')}`, `JAHB${i}.1`, 1 + (i % 2), 0, 0);
		if (scattered && i % 20 === 0) fillNodes(i, 1);
	}
	if (!scattered) createRefIndex();
	const ref = db.prepare('INSERT INTO ReferenceIndex VALUES (?, ?, ?, ?)');
	for (let i = 0; i < 2000; i++) ref.run(0, i * 1024, i, 0);
	db.exec('COMMIT');

	const stat = (sql: string) => db.prepare(sql).all() as Record<string, number>[];
	const pathPages = stat(`SELECT pageno FROM dbstat WHERE name = 'Paths'`).map((r) => r.pageno);
	const depth = stat(`SELECT MAX(LENGTH(path) - LENGTH(REPLACE(path, '/', ''))) AS d FROM dbstat WHERE name = 'Paths'`)[0].d;
	const roots = new Map(
		(db.prepare(`SELECT name, rootpage FROM sqlite_master`).all() as { name: string; rootpage: number }[]).map(
			(r) => [r.name, r.rootpage]
		)
	);
	db.close();
	return { buf: new Uint8Array(readFileSync(file)), pathPages, depth, roots };
}

const blockOf = (page: number) => Math.floor(((page - 1) * PAGE) / BLOCK);

describe('readSchema', () => {
	it('finds every table and index root page', () => {
		const { buf, roots } = buildDb('schema.db', false);
		expect(readSchema(buf.subarray(0, PAGE), PAGE)).toEqual(roots);
	});
});

describe('warmGbzDb', () => {
	it('pulls in the whole Paths table in one request when it was filled in one pass', async () => {
		const { buf, pathPages, depth } = buildDb('contiguous.db', false);
		expect(depth).toBe(3); // a 3-level tree, like Paths on the HPRC graphs
		const reader = new FakeReader(buf);
		await warmGbzDb(reader);
		const missing = pathPages.filter((p) => !reader.cached.has(blockOf(p)));
		expect(missing).toEqual([]);
		// The header block, then the Paths span; the level walk is all cache hits.
		expect(reader.requestCount).toBe(2);
	});

	it('still covers Paths, level by level, when its pages are scattered', async () => {
		const { buf, pathPages } = buildDb('scattered.db', true);
		const reader = new FakeReader(buf);
		await warmGbzDb(reader);
		expect(pathPages.filter((p) => !reader.cached.has(blockOf(p)))).toEqual([]);
		// The extent guess fell short, so the walk had to fetch the levels itself.
		expect(reader.requestCount).toBeGreaterThan(2);
	});

	it('does nothing for a file that is not SQLite', async () => {
		const reader = new FakeReader(new Uint8Array(BLOCK * 4).fill(7));
		await warmGbzDb(reader);
		expect(reader.requestCount).toBe(1); // just the header probe
	});
});
